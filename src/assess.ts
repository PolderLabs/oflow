import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, resolvePipelinePolicy } from "./config.js";
import { loadStoryContext, selectVerificationEvidence } from "./context.js";
import { evaluateCriteria, parseVerificationEvidence } from "./criteria.js";
import { OflowError } from "./errors.js";
import { getCurrentBranch, runGit } from "./git.js";
import { runCustomQuestions } from "./laya-runner.js";
import { probeReadability } from "./laya-runner.js";
import { readTextReadability } from "./laya-readability.js";
import { SCRUM_QUESTIONS, readVerificationShare, describeVerificationShare } from "./laya-scrum.js";

/**
 * Ask Laya how much of a story is verification work rather than construction.
 *
 * Entirely optional and entirely advisory. The engine's checkpoint disowns its
 * own confidences, so a missing engine, a failure, or an uncalibrated answer
 * all yield `undefined` -- never a blocker, and never a change to the status.
 */
async function triageAssessment(
  title: string,
  description: string | null | undefined,
): Promise<AssessmentResult["triage"]> {
  // Withheld on measurement, and checked before any engine call so the common
  // case costs nothing. Measured on 24 stories built the way this function
  // assembles them -- title plus a description with acceptance criteria -- the
  // question put construction work at 1.63-2.02 and verification work at
  // 1.70-2.23: 75% false alarms, precision 0.47. Every construction story sat
  // above the 1.5 edge, and the highest-scoring one was "Add iteration
  // listing", which is plainly new work. The classes overlap too far to
  // separate by moving an edge, so the band is not the problem and no
  // threshold would fix this. The question needs recalibrating on real story
  // text before this path says anything.
  if (process.env.OFLOW_LAYA_TRIAGE_UNCALIBRATED !== "1") return undefined;

  const text = [title, description]
    .filter((part) => typeof part === "string" && part.trim() !== "")
    .join("\n");

  // A precondition, not a fix. Measured over 23 cases against the real
  // engine, the readability check never calls text it cannot read "readable"
  // for the scripts it screens -- German, Japanese, Hindi, Korean, Chinese,
  // Russian, Greek, Arabic, Hebrew and Thai all read false. It is not a
  // language filter: French, Portuguese and Dutch read TRUE and pass
  // through, so non-English text does reach the question in those languages.
  // For what it screens the signal is weaker on non-English input and never
  // wrong-signed, which is worth having; for what it lets through that is
  // unverified. Do not read this as "safe on any language".
  // Pass the arguments through. Handing probeReadability to the module as a
  // bare reference meant it was called with one argument, so options defaulted
  // to {} and the interpreter resolved from PATH rather than
  // OFLOW_LAYA_PYTHON. The probe then failed, the catch returned null, and
  // this gate never fired at all -- a precondition that was present, tested and
  // never actually ran.
  const readability = await readTextReadability(
    text,
    (texts) => probeReadability(texts),
  );
  if (readability !== null && !readability.readable) return undefined;

  const answers = await runCustomQuestions(text, SCRUM_QUESTIONS);
  const value = readVerificationShare(answers);
  if (value === null) return undefined;
  const note = describeVerificationShare(value);
  if (note === null) return undefined;
  return {
    verificationShare: { score: value.score, band: value.band, uncertain: value.uncertain },
    note: note + " (advisory; verification-share estimate from an uncalibrated checkpoint)",
  };
}

export type CriterionStatus = "satisfied" | "partial" | "blocked" | "unknown";
export type AssessmentStatus = "satisfied" | "in-progress" | "blocked" | "unknown";

export interface AssessmentCriterion {
  id: string;
  text: string;
  status: CriterionStatus;
  checked: boolean;
  evidence: string[];
  localReferences: LocalCriterionReference[];
  reason: string;
}

export interface LocalCriterionReference {
  kind: "code" | "test";
  path: string;
  line: number;
}

export interface LocalEvidence {
  branch: string | null;
  clean: boolean;
  changedFiles: string[];
  diffStat: string | null;
  recentCommits: string[];
}

export interface LocalCriterionEvidence {
  id: string;
  references: LocalCriterionReference[];
}

export interface AssessmentResult {
  generatedAt: string;
  story: {
    iid: number;
    title: string;
    issueType: string | null;
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
  pipelinePolicy: "enabled" | "disabled";
  ciConfigPresent: boolean;
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
  /**
   * Optional Laya triage, present only when the engine was reached and
   * `triage` was requested. Never a blocker: the engine's own checkpoint
   * disowns its confidences, so this is context for a human, not a gate.
   */
  triage?: {
    verificationShare: {
      score: number;
      band: "construction" | "mixed" | "verification";
      uncertain: boolean;
    };
    note: string;
  };
  blockers: string[];
  nextActions: string[];
  warnings: string[];
}

export async function assessStory(
  root: string,
  storyIid: number,
  options: { triage?: boolean } = {},
): Promise<AssessmentResult> {
  if (!Number.isSafeInteger(storyIid) || storyIid < 1) {
    throw new OflowError("Story IID must be a positive integer.", "INVALID_ISSUE_IID");
  }

  const context = await loadStoryContext(root, storyIid);
  const verificationEvidence = selectVerificationEvidence(context);
  const mergeRequest = verificationEvidence.mergeRequest;
  const pipeline = verificationEvidence.pipeline;
  const config = await loadConfig(root);
  const pipelinePolicy = resolvePipelinePolicy(config);
  const ciConfigPresent = await fileExists(join(root, ".gitlab-ci.yml"));
  const verification = evaluateCriteria(
    context.criteria,
    mergeRequest?.description,
    pipeline?.status,
    { pipelinePolicy, ciConfigPresent },
  );
  const evidenceRecords = parseVerificationEvidence(mergeRequest?.description);
  const blockerNotes = context.recentNotes.filter((note) => isBlockerNote(note.body));
  const pipelineBlocks =
    pipelinePolicy === "enabled" &&
    (pipeline
      ? pipeline.status?.toLowerCase() !== "success"
      : !(ciConfigPresent === false && pipeline === null));
  const blockers = [
    ...blockerNotes.slice(0, 3).map((note) => "GitLab note: " + compact(note.body, 180)),
    ...(pipelineBlocks
      ? ["Latest pipeline is " + (pipeline?.status ?? "unknown") + "; expected success."]
      : []),
  ];
  const collectedLocal = await collectLocalEvidence(
    root,
    context.criteria.map((criterion) => criterion.id),
  );
  const local = collectedLocal.evidence;
  const localCriteria = new Map(
    collectedLocal.criteria.map((criterion) => [criterion.id, criterion.references]),
  );
  const criteria = verification.checks.map((check) => {
    const record = evidenceRecords.get(check.id);
    const status = criterionStatus(check.verified, record, blockers.length > 0);
    return {
      id: check.id,
      text: compact(check.text, 240),
      status,
      checked: check.checked,
      evidence: check.evidence.slice(0, 2).map((item) => compact(item, 180)),
      localReferences: localCriteria.get(check.id) ?? [],
      reason: check.reason,
    };
  });
  const status = overallStatus(criteria, verification.pipelineStatus, blockers, {
    pipelinePolicy,
    ciConfigPresent,
  });
  const milestone = namedValue(context.story.milestone);
  const iteration = namedValue(context.story.iteration);
  const assignees = usernamesFrom(context.story.assignees);
  return {
    generatedAt: new Date().toISOString(),
    story: {
      iid: context.story.iid,
      title: compact(context.story.title, 240),
      issueType: typeof context.story.issue_type === "string" ? context.story.issue_type : null,
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
    pipelinePolicy,
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
    triage: options.triage === true
      ? await triageAssessment(context.story.title, context.story.description)
      : undefined,
    blockers,
    nextActions: nextActions(
      status,
      criteria,
      mergeRequest,
      pipeline,
      local,
      assignees.length > 0,
      milestone !== null || iteration !== null,
      { pipelinePolicy, ciConfigPresent },
    ),
    warnings: unique([
      ...context.warnings,
      ...(verificationEvidence.warning ? [verificationEvidence.warning] : []),
    ]),
    ciConfigPresent,
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
          "- " + criterion.status.toUpperCase() + " " + criterion.id + ": " + criterion.reason +
          (criterion.localReferences.length > 0
            ? " (local references: " + criterion.localReferences.length + ")"
            : ""),
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
  if (result.triage !== undefined) {
    lines.push("", "## Triage", "", "- " + result.triage.note);
  }
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
  options: { pipelinePolicy: "enabled" | "disabled"; ciConfigPresent: boolean },
): AssessmentStatus {
  if (blockers.length > 0) {
    return "blocked";
  }
  const pipelineSatisfied =
    options.pipelinePolicy === "disabled" ||
    pipelineStatus?.toLowerCase() === "success" ||
    (pipelineStatus === null && options.ciConfigPresent === false);
  if (
    criteria.length > 0 &&
    criteria.every((criterion) => criterion.status === "satisfied") &&
    pipelineSatisfied
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
  options: { pipelinePolicy: "enabled" | "disabled"; ciConfigPresent: boolean },
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
  if (options.pipelinePolicy === "disabled") {
    actions.push("Pipeline policy is disabled; the pipeline gate is skipped by configuration.");
  } else if (
    pipeline
      ? pipeline.status?.toLowerCase() !== "success"
      : !(options.ciConfigPresent === false)
  ) {
    actions.push("Run or fix the relevant pipeline before claiming completion.");
  } else if (pipeline === null && options.ciConfigPresent === false) {
    actions.push("No .gitlab-ci.yml and no pipeline evidence; treated as a warning, not a permanent block.");
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectLocalEvidence(
  root: string,
  criterionIds: string[] = [],
): Promise<{ evidence: LocalEvidence; criteria: LocalCriterionEvidence[] }> {
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
    evidence: {
      branch,
      clean: changedFiles.length === 0,
      changedFiles,
      diffStat: diffStat ? compact(diffStat, 1200) : null,
      recentCommits: commits.split(/\r?\n/).filter(Boolean).slice(0, 5),
    },
    criteria: await collectLocalCriterionEvidence(root, criterionIds, changedFiles),
  };
}

const MAX_LOCAL_EVIDENCE_FILES = 250;
const MAX_LOCAL_EVIDENCE_FILE_BYTES = 256 * 1024;
const MAX_LOCAL_EVIDENCE_TOTAL_BYTES = 2 * 1024 * 1024;

async function collectLocalCriterionEvidence(
  root: string,
  criterionIds: string[],
  changedFiles: string[],
): Promise<LocalCriterionEvidence[]> {
  const ids = [...new Set(criterionIds.map((id) => id.toUpperCase()))];
  if (ids.length === 0) {
    return [];
  }
  const idSet = new Set(ids);
  const listedFiles = (await optionalGit(
    root,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  ))
    .split("\0")
    .filter((filePath) => filePath.length > 0)
    .filter(isCandidateEvidenceFile);
  const changed = new Set(changedFiles);
  const files = listedFiles
    .sort((left, right) => Number(changed.has(right)) - Number(changed.has(left)))
    .slice(0, MAX_LOCAL_EVIDENCE_FILES);
  const references = new Map<string, LocalCriterionReference[]>();
  let totalBytes = 0;

  for (const filePath of files) {
    if (totalBytes >= MAX_LOCAL_EVIDENCE_TOTAL_BYTES || !safeRelativePath(filePath)) {
      break;
    }
    let fileSize: number;
    try {
      fileSize = (await stat(join(root, filePath))).size;
    } catch {
      continue;
    }
    if (fileSize > MAX_LOCAL_EVIDENCE_FILE_BYTES ||
      totalBytes + fileSize > MAX_LOCAL_EVIDENCE_TOTAL_BYTES) {
      continue;
    }

    let contents: string;
    try {
      contents = await readFile(join(root, filePath), "utf8");
    } catch {
      continue;
    }
    totalBytes += fileSize;
    const kind = isTestPath(filePath) ? "test" : "code";
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      for (const match of line.matchAll(/\b[A-Za-z]+-\d+\b/g)) {
        const id = match[0].toUpperCase();
        if (!idSet.has(id)) {
          continue;
        }
        const list = references.get(id) ?? [];
        if (list.length < 3) {
          list.push({ kind, path: filePath, line: index + 1 });
          references.set(id, list);
        }
      }
    }
  }

  return ids.map((id) => ({
    id,
    references: references.get(id) ?? [],
  }));
}

function isCandidateEvidenceFile(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (
    normalized.startsWith(".oflow/") ||
    /(^|\/)(?:\.git|node_modules|dist|build|coverage|vendor)(?:\/|$)/i.test(normalized)
  ) {
    return false;
  }
  return /\.(?:[cm]?[jt]sx?|py|java|kt|go|rs|rb|php|cs|swift|sql|sh|vue|svelte|html|css|scss|ya?ml)$/i.test(normalized);
}

function isTestPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  return /(^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)/i.test(normalized) ||
    /(?:\.test|\.spec)\.[^.]+$/i.test(normalized);
}

function safeRelativePath(filePath: string): boolean {
  return !filePath.startsWith("/") && !filePath.split(/[\\/]/).includes("..");
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
