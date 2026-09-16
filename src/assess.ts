import { chooseMergeRequest, loadStoryContext } from "./context.js";
import { evaluateCriteria, parseVerificationEvidence } from "./criteria.js";
import { OflowError } from "./errors.js";
import { getCurrentBranch, runGit } from "./git.js";

export type CriterionStatus = "satisfied" | "partial" | "blocked" | "unknown";
export type AssessmentStatus = "satisfied" | "in-progress" | "blocked" | "unknown";

export interface AssessmentCriterion {
  id: string;
  text: string;
  status: CriterionStatus;
  checked: boolean;
  evidence: string[];
  reason: string;
}

export interface LocalEvidence {
  branch: string | null;
  clean: boolean;
  changedFiles: string[];
  diffStat: string | null;
  recentCommits: string[];
}

export interface AssessmentResult {
  generatedAt: string;
  story: {
    iid: number;
    title: string;
    state: string | null;
    labels: string[];
    assignees: string[];
    milestone: string | null;
    iteration: string | null;
    startDate: string | null;
    dueDate: string | null;
    weight: number | null;
    taskCompletion: {
      completed: number;
      total: number;
    } | null;
    webUrl: string | null;
  };
  status: AssessmentStatus;
  criteria: AssessmentCriterion[];
  remote: {
    mergeRequest: {
      iid: number;
      title: string;
      state: string | null;
      draft: boolean;
      webUrl: string | null;
    } | null;
    pipeline: {
      id: number;
      status: string | null;
      ref: string | null;
      webUrl: string | null;
    } | null;
    notes: Array<{
      id: number;
      body: string;
      createdAt: string | null;
      author: string | null;
    }>;
  };
  local: LocalEvidence;
  blockers: string[];
  nextActions: string[];
  warnings: string[];
}

export async function assessStory(
  root: string,
  storyIid: number,
): Promise<AssessmentResult> {
  if (!Number.isSafeInteger(storyIid) || storyIid < 1) {
    throw new OflowError("Story IID must be a positive integer.", "INVALID_ISSUE_IID");
  }

  const context = await loadStoryContext(root, storyIid);
  const mergeRequest = chooseMergeRequest(context);
  const pipeline = context.pipelines[0] ?? null;
  const verification = evaluateCriteria(
    context.criteria,
    mergeRequest?.description,
    pipeline?.status,
  );
  const evidenceRecords = parseVerificationEvidence(mergeRequest?.description);
  const blockerNotes = context.recentNotes.filter((note) => isBlockerNote(note.body));
  const blockers = [
    ...blockerNotes.slice(0, 3).map((note) => "GitLab note: " + compact(note.body, 180)),
    ...(pipeline && pipeline.status?.toLowerCase() !== "success"
      ? ["Latest pipeline is " + (pipeline.status ?? "unknown") + "; expected success."]
      : []),
  ];
  const criteria = verification.checks.map((check) => {
    const record = evidenceRecords.get(check.id);
    const status = criterionStatus(check.verified, record, blockers.length > 0);
    return {
      id: check.id,
      text: compact(check.text, 240),
      status,
      checked: check.checked,
      evidence: check.evidence.slice(0, 2).map((item) => compact(item, 180)),
      reason: check.reason,
    };
  });
  const local = await collectLocalEvidence(root);
  const status = overallStatus(criteria, verification.pipelineStatus, blockers);
  const milestone = namedValue(context.story.milestone);
  const iteration = namedValue(context.story.iteration);
  const assignees = usernamesFrom(context.story.assignees);
  return {
    generatedAt: new Date().toISOString(),
    story: {
      iid: context.story.iid,
      title: compact(context.story.title, 240),
      state: context.story.state ?? null,
      labels: context.story.labels ?? [],
      assignees,
      milestone,
      iteration,
      startDate: context.story.start_date ?? null,
      dueDate: context.story.due_date ?? null,
      weight: context.story.weight ?? null,
      taskCompletion: compactTaskCompletion(context.story.task_completion_status),
      webUrl: context.story.web_url ?? null,
    },
    status,
    criteria,
    remote: {
      mergeRequest: mergeRequest
        ? {
            iid: mergeRequest.iid,
            title: compact(mergeRequest.title, 180),
            state: mergeRequest.state ?? null,
            draft: mergeRequest.draft === true,
            webUrl: mergeRequest.web_url ?? null,
          }
        : null,
      pipeline: pipeline
        ? {
            id: pipeline.id,
            status: pipeline.status ?? null,
            ref: pipeline.ref ?? null,
            webUrl: pipeline.web_url ?? null,
          }
        : null,
      notes: context.recentNotes.slice(0, 5).map((note) => ({
        id: note.id,
        body: compact(note.body, 180),
        createdAt: note.created_at ?? null,
        author: note.author && typeof note.author.username === "string"
          ? note.author.username
          : null,
      })),
    },
    local,
    blockers,
    nextActions: nextActions(
      status,
      criteria,
      mergeRequest,
      pipeline,
      local,
      assignees.length > 0,
      milestone !== null || iteration !== null,
    ),
    warnings: context.warnings,
  };
}

export function formatAssessmentMarkdown(result: AssessmentResult): string {
  const lines = [
    "# oflow assess",
    "",
    "Story: " + linkOrText("#" + result.story.iid + " " + result.story.title, result.story.webUrl),
    "Status: " + result.status,
    "Assignees: " + (result.story.assignees.length > 0 ? result.story.assignees.join(", ") : "none"),
    "Timebox: " + (result.story.milestone ?? result.story.iteration ?? "none"),
    ...(result.story.taskCompletion
      ? ["Tasks: " + result.story.taskCompletion.completed + "/" + result.story.taskCompletion.total]
      : []),
    "Branch: " + (result.local.branch ?? "detached/unknown"),
    "Working tree: " + (result.local.clean ? "clean" : "changes present"),
    "",
    "## Acceptance criteria",
    "",
  ];
  if (result.criteria.length === 0) {
    lines.push("_No acceptance criteria found._");
  } else {
    lines.push(
      ...result.criteria.map(
        (criterion) =>
          "- " + criterion.status.toUpperCase() + " " + criterion.id + ": " + criterion.reason,
      ),
    );
  }
  lines.push(
    "",
    "## Remote evidence",
    "",
    "Merge request: " +
      (result.remote.mergeRequest
        ? "!" + result.remote.mergeRequest.iid + " " + result.remote.mergeRequest.title
        : "none"),
    "Pipeline: " +
      (result.remote.pipeline
        ? "#" + result.remote.pipeline.id + " " + (result.remote.pipeline.status ?? "unknown")
        : "none"),
    "Notes sampled: " + result.remote.notes.length,
    "",
    "## Local evidence",
    "",
    "Changed files: " + String(result.local.changedFiles.length),
    ...(result.local.diffStat ? [result.local.diffStat] : []),
  );
  if (result.nextActions.length > 0) {
    lines.push("", "## Next actions", "", ...result.nextActions.map((action) => "- " + action));
  }
  if (result.blockers.length > 0) {
    lines.push("", "## Blockers", "", ...result.blockers.map((blocker) => "- " + blocker));
  }
  if (result.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...result.warnings.map((warning) => "- " + warning));
  }
  lines.push("", "This is deterministic evidence; the agent should reason over it and request approval before any write.", "");
  return lines.join("\n");
}

function criterionStatus(
  verified: boolean,
  record: { checked: boolean; evidence: string[] } | undefined,
  hasBlocker: boolean,
): CriterionStatus {
  if (verified) {
    return "satisfied";
  }
  if (hasBlocker && (record?.checked === true || (record?.evidence.length ?? 0) > 0)) {
    return "blocked";
  }
  if (record?.checked === true || (record?.evidence.length ?? 0) > 0) {
    return "partial";
  }
  return "unknown";
}

function overallStatus(
  criteria: AssessmentCriterion[],
  pipelineStatus: string | null,
  blockers: string[],
): AssessmentStatus {
  if (blockers.length > 0) {
    return "blocked";
  }
  if (
    criteria.length > 0 &&
    criteria.every((criterion) => criterion.status === "satisfied") &&
    pipelineStatus?.toLowerCase() === "success"
  ) {
    return "satisfied";
  }
  if (criteria.some((criterion) => criterion.status === "satisfied" || criterion.status === "partial")) {
    return "in-progress";
  }
  return "unknown";
}

function nextActions(
  status: AssessmentStatus,
  criteria: AssessmentCriterion[],
  mergeRequest: { iid: number } | null,
  pipeline: { status?: string } | null,
  local: LocalEvidence,
  hasAssignee: boolean,
  hasTimebox: boolean,
): string[] {
  const actions: string[] = [];
  if (!hasAssignee) {
    actions.push("Assign an owner or explicitly confirm why the story is unassigned.");
  }
  if (!hasTimebox) {
    actions.push("Assign a milestone or iteration before sprint commitment.");
  }
  if (!mergeRequest) {
    actions.push("Create or link a merge request for the story.");
  }
  if (criteria.some((criterion) => criterion.status !== "satisfied")) {
    actions.push("Complete the missing acceptance-criterion checklist and concrete Evidence: lines.");
  }
  if (!pipeline || pipeline.status?.toLowerCase() !== "success") {
    actions.push("Run or fix the relevant pipeline before claiming completion.");
  }
  if (!local.clean) {
    actions.push("Review the local changes and capture their test evidence.");
  }
  if (status === "blocked") {
    actions.push("Resolve or record ownership for the reported blocker before applying planning changes.");
  } else if (status === "satisfied") {
    actions.push("Run oflow verify --story <iid> and prepare handoff evidence.");
  }
  return unique(actions);
}

async function collectLocalEvidence(root: string): Promise<LocalEvidence> {
  const branch = await getCurrentBranch(root);
  const status = await optionalGit(root, ["status", "--short"]);
  const diffStat = await optionalGit(root, ["diff", "--stat"]);
  const commits = await optionalGit(root, ["log", "-5", "--pretty=format:%h %s"]);
  const changedFiles = status
    .split(/\r?\n/)
    .map((line) => line.replace(/^[ MADRCUT?!]{2}/, "").trim())
    .filter(Boolean)
    .slice(0, 50);
  return {
    branch,
    clean: changedFiles.length === 0,
    changedFiles,
    diffStat: diffStat ? compact(diffStat, 1200) : null,
    recentCommits: commits.split(/\r?\n/).filter(Boolean).slice(0, 5),
  };
}

async function optionalGit(root: string, args: string[]): Promise<string> {
  try {
    return await runGit(args, root);
  } catch {
    return "";
  }
}

function isBlockerNote(body: string): boolean {
  return /\b(?:blocked|blocker|blocked by|waiting for|cannot proceed)\b/i.test(body);
}

function namedValue(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = record.name ?? record.title;
  return typeof name === "string" ? name : null;
}

function usernamesFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => item.username ?? item.name)
      .filter((username): username is string => typeof username === "string" && username.trim().length > 0)
    : [];
}

function compactTaskCompletion(value: unknown): AssessmentResult["story"]["taskCompletion"] {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.count !== "number" || typeof record.completed_count !== "number") {
    return null;
  }
  return {
    completed: record.completed_count,
    total: record.count,
  };
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}

function linkOrText(text: string, url: string | null): string {
  return url ? "[" + text + "](" + url + ")" : text;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
