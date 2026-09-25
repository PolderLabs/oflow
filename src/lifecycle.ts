/**
 * Agent lifecycle commands (vNext architecture, PR 8-9).
 *
 * `oflow start` composes work selection, story context, assessment, and
 * execution-backend resolution into one compact agent entry point.
 * `oflow check` unifies local git state, story assessment, MR/pipeline
 * evidence, and policy into a single next-action summary.
 * `oflow finish` is a read-only completion gate that prints the guarded
 * close command; `oflow handoff` emits compact resume context for the
 * next agent.
 * All are compositions over existing primitives; they add no new remote
 * calls beyond what `work --mine`/`context`/`assess` already make.
 */

import { assessStory } from "./assess.js";
import { resolveAuth } from "./auth-resolver.js";
import { compactWorkItems, getCurrentGitLabUser, listWorkItems } from "./context.js";
import { loadConfig } from "./config.js";
import { getLocalVerificationStatus, type LocalVerificationStatus } from "./local-verification.js";
import { OflowError } from "./errors.js";
import { getCurrentBranch } from "./git.js";
import { loadStoryContext } from "./context.js";
import { dim, statusMarker } from "./presentation.js";
import type { PresentationOptions } from "./presentation.js";
import type { GitLabIssue } from "./types.js";

export interface StartOptions {
  root: string;
  story?: number;
  /** Skip the execution-backend probe (env/glab subprocess checks). */
  skipAuthProbe?: boolean;
}

export interface StartResult {
  generatedAt: string;
  project: {
    host: string;
    path: string;
  };
  branch: string | null;
  work: {
    iid: number;
    title: string;
    issueType: string | null;
    state: string | null;
    webUrl: string | null;
    assignees: string[];
    labels: string[];
  };
  acceptanceCriteria: Array<{
    id: string;
    text: string;
    checked: boolean;
  }>;
  parent: {
    iid: number;
    title: string;
  } | null;
  recommendation: {
    reason: string;
  };
  git: {
    branchRecommendation: string | null;
  };
  execution: {
    gitlabMcpConfigured: boolean;
    authenticatedTransport: boolean;
    preferredRemoteMutationBackend: string;
    verificationBackend: string;
  };
  warnings: string[];
}

function slugifyBranch(iid: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? iid + "-" + slug : String(iid);
}

async function pickStory(
  root: string,
  explicit?: number,
): Promise<{ story: GitLabIssue; reason: string }> {
  if (explicit) {
    const context = await loadStoryContext(root, explicit);
    return {
      story: context.story,
      reason: "story " + explicit + " selected explicitly",
    };
  }
  const user = await getCurrentGitLabUser(root);
  const mine = await listWorkItems(root, "opened", { assignee: user.username });
  if (mine.length === 0) {
    throw new OflowError(
      "No opened work item is assigned to @" +
        user.username +
        ". Pass --story <iid> or assign work in GitLab first.",
      "NO_ASSIGNED_WORK",
    );
  }
  const inProgress = mine.find((issue) =>
    (issue.labels ?? []).some((label) => /in progress/i.test(label)),
  );
  const story = inProgress ?? mine[0];
  const reason = inProgress
    ? "in progress and assigned to @" + user.username
    : "first opened item assigned to @" + user.username + " (none in progress)";
  return { story, reason };
}

export async function startWork(options: StartOptions): Promise<StartResult> {
  const { root } = options;
  const { story, reason } = await pickStory(root, options.story);
  const context = await loadStoryContext(root, story.iid);
  const config = context.project;

  const warnings: string[] = [...context.warnings];
  if (context.criteria.length === 0) {
    warnings.push("Story has no parsed acceptance criteria.");
  }

  const auth = options.skipAuthProbe
    ? null
    : await resolveAuth({
        host: config.web_url ? new URL(config.web_url).host : "",
        root,
      }).catch(() => null);

  const parent =
    context.epic && typeof context.epic.iid === "number"
      ? {
          iid: context.epic.iid as number,
          title: String(context.epic.title ?? ""),
        }
      : null;

  return {
    generatedAt: new Date().toISOString(),
    project: {
      host: config.web_url ? new URL(config.web_url).host : "",
      path: config.path_with_namespace,
    },
    branch: await getCurrentBranch(root),
    work: {
      iid: story.iid,
      title: story.title,
      issueType: typeof story.issue_type === "string" ? story.issue_type : null,
      state: story.state ?? null,
      webUrl: story.web_url ?? null,
      assignees: (story.assignees ?? []).map((a) => String(a.username ?? "")),
      labels: story.labels ?? [],
    },
    acceptanceCriteria: context.criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      checked: criterion.checked,
    })),
    parent,
    recommendation: { reason },
    git: {
      branchRecommendation:
        "work/" + slugifyBranch(story.iid, story.title),
    },
    execution: {
      gitlabMcpConfigured:
        auth?.sources.some((s) => s.source === "mcp-runtime") ?? false,
      authenticatedTransport: auth?.authenticated ?? false,
      preferredRemoteMutationBackend: auth?.mutationBackend ?? "unprobed",
      verificationBackend: auth?.readBackend ?? "unprobed",
    },
    warnings,
  };
}

export function formatStartMarkdown(result: StartResult): string {
  const lines = [
    "# oflow start",
    "",
    "Project: " + result.project.host + "/" + result.project.path,
    "Story: !" + result.work.iid + " " + result.work.title,
    "Selected because: " + result.recommendation.reason,
    "Branch now: " + (result.branch ?? "(detached)"),
    "Branch recommendation: " + (result.git.branchRecommendation ?? "-"),
    "",
    "## Acceptance criteria",
    "",
  ];
  if (result.acceptanceCriteria.length === 0) {
    lines.push("- (none parsed)");
  }
  for (const criterion of result.acceptanceCriteria) {
    lines.push(
      "- [" + (criterion.checked ? "x" : " ") + "] " + criterion.id + ": " + criterion.text,
    );
  }
  if (result.parent) {
    lines.push("", "Parent: !" + result.parent.iid + " " + result.parent.title);
  }
  lines.push(
    "",
    "## Execution",
    "",
    "GitLab MCP configured: " + (result.execution.gitlabMcpConfigured ? "yes" : "no"),
    "Authenticated transport: " + (result.execution.authenticatedTransport ? "yes" : "no"),
    "Preferred mutation backend: " + result.execution.preferredRemoteMutationBackend,
    "Verification backend: " + result.execution.verificationBackend,
  );
  if (result.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...result.warnings.map((w) => "- " + w));
  }
  return lines.join("\n") + "\n";
}

export interface CheckOptions {
  root: string;
  story?: number;
}

export interface CheckResult {
  generatedAt: string;
  story: number;
  status: string;
  criteria: Array<{
    id: string;
    status: string;
    evidence: string[];
    localReferences: string[];
  }>;
  mergeRequest: { iid: number; state: string | null; draft: boolean } | null;
  pipeline: { id: number; status: string | null } | null;
  local: {
    branch: string | null;
    clean: boolean;
  };
  repositoryVerification: LocalVerificationStatus;
  nextAction: string;
  warnings: string[];
}

export async function checkStory(options: CheckOptions): Promise<CheckResult> {
  const config = await loadConfig(options.root);
  const repositoryVerification = await getLocalVerificationStatus(
    options.root,
    config?.workflow?.verification,
  );
  const { story } = await pickStory(options.root, options.story);
  const assessment = await assessStory(options.root, story.iid);

  const nextAction = assessment.nextActions[0]
    ?? (assessment.status === "satisfied"
      ? "Story looks complete; run oflow verify --story " + story.iid + " for delivery checks."
      : "Continue implementation; see assessment details.");

  return {
    generatedAt: new Date().toISOString(),
    story: story.iid,
    status: assessment.status,
    criteria: assessment.criteria.map((criterion) => ({
      id: criterion.id,
      status: criterion.status,
      evidence: criterion.evidence,
      localReferences: criterion.localReferences.map(
        (reference) => reference.path + ":" + reference.line + " (" + reference.kind + ")",
      ),
    })),
    mergeRequest: assessment.remote.mergeRequest
      ? {
          iid: assessment.remote.mergeRequest.iid,
          state: assessment.remote.mergeRequest.state,
          draft: assessment.remote.mergeRequest.draft,
        }
      : null,
    pipeline: assessment.remote.pipeline
      ? { id: assessment.remote.pipeline.id, status: assessment.remote.pipeline.status }
      : null,
    local: {
      branch: assessment.local.branch,
      clean: assessment.local.clean,
    },
    repositoryVerification,
    nextAction,
    warnings: assessment.warnings,
  };
}

export function formatCheckMarkdown(result: CheckResult): string {
  const lines = [
    "# oflow check",
    "",
    "Story !" + result.story + " — " + result.status,
    "",
    "## Criteria",
    "",
  ];
  if (result.criteria.length === 0) {
    lines.push("- (none parsed)");
  }
  for (const criterion of result.criteria) {
    lines.push("- " + criterion.id + ": " + criterion.status);
    for (const item of criterion.evidence) {
      lines.push("  evidence: " + item);
    }
    for (const reference of criterion.localReferences) {
      lines.push("  local: " + reference);
    }
  }
  lines.push(
    "",
    "Merge request: " + (result.mergeRequest
      ? "!" + result.mergeRequest.iid + " (" + result.mergeRequest.state + (result.mergeRequest.draft ? ", draft" : "") + ")"
      : "missing"),
    "Pipeline: " + (result.pipeline
      ? "#" + result.pipeline.id + " (" + (result.pipeline.status ?? "unknown") + ")"
      : "missing"),
    "Local: " + (result.local.branch ?? "(detached)") + (result.local.clean ? ", clean" : ", dirty"),
    "",
    "Next action: " + result.nextAction,
  );
  if (result.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...result.warnings.map((w) => "- " + w));
  }
  return lines.join("\n") + "\n";
}

export interface FinishOptions {
  root: string;
  story?: number;
}

export interface FinishResult {
  generatedAt: string;
  story: number;
  ready: boolean;
  gates: Array<{ id: string; passed: boolean; detail: string }>;
  repositoryVerification: LocalVerificationStatus;
  nextCommand: string;
  warnings: string[];
}

/**
 * Read-only completion gate: reports whether a story is ready to close and
 * prints the guarded plan command that would close it. Never mutates.
 */
export async function finishStory(options: FinishOptions): Promise<FinishResult> {
  const config = await loadConfig(options.root);
  const repositoryVerification = await getLocalVerificationStatus(
    options.root,
    config?.workflow?.verification,
  );
  const { story } = await pickStory(options.root, options.story);
  const assessment = await assessStory(options.root, story.iid);

  const unsatisfied = assessment.criteria.filter(
    (criterion) => criterion.status !== "satisfied",
  );
  const mergeRequest = assessment.remote.mergeRequest;
  const pipeline = assessment.remote.pipeline;
  const pipelinePolicy = assessment.pipelinePolicy;
  const pipelineGate = pipelinePolicy === "disabled"
    ? {
        id: "pipeline",
        passed: true,
        detail: "Pipeline policy is disabled for this project.",
      }
    : pipeline === null && assessment.ciConfigPresent === false
      ? {
          id: "pipeline",
          passed: true,
          detail: "Pipeline evidence is unknown because no .gitlab-ci.yml or pipeline was found; treated as a warning.",
        }
      : {
          id: "pipeline",
          passed: pipeline !== null && pipeline.status?.toLowerCase() === "success",
          detail: pipeline
            ? "Pipeline #" + pipeline.id + " status: " + (pipeline.status ?? "unknown") + "."
            : "No pipeline evidence found.",
        };
  const gates = [
    {
      id: "acceptance-criteria",
      passed: assessment.criteria.length > 0 && unsatisfied.length === 0,
      detail: assessment.criteria.length === 0
        ? "No parsed acceptance criteria."
        : unsatisfied.length === 0
          ? "All " + assessment.criteria.length + " criteria satisfied."
          : unsatisfied.length + " of " + assessment.criteria.length + " criteria not satisfied: " +
            unsatisfied.map((criterion) => criterion.id).join(", ") + ".",
    },
    {
      id: "merge-request",
      passed: mergeRequest !== null && mergeRequest.state === "merged",
      detail: mergeRequest
        ? "!" + mergeRequest.iid + " (" + mergeRequest.state + (mergeRequest.draft ? ", draft" : "") + "); finish requires merged."
        : "No merge request references this story yet.",
    },
    pipelineGate,
    {
      id: "local-git",
      passed: assessment.local.clean,
      detail: assessment.local.clean
        ? "Working tree clean on " + (assessment.local.branch ?? "(detached)") + "."
        : "Uncommitted changes: " + assessment.local.changedFiles.length + " file(s).",
    },
    {
      id: "repository-verification",
      passed: !repositoryVerification.blocking,
      detail: repositoryVerification.reason,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    story: story.iid,
    ready: gates.every((gate) => gate.passed),
    gates,
    repositoryVerification,
    nextCommand:
      "oflow plan issue update --story " + story.iid + " --state closed",
    warnings: [
      ...assessment.warnings,
      ...(pipelinePolicy === "enabled" && pipeline === null && assessment.ciConfigPresent === false
        ? ["Pipeline evidence is unknown because no .gitlab-ci.yml or pipeline was found."]
        : []),
    ],
  };
}

export function formatFinishMarkdown(
  result: FinishResult,
  presentation: PresentationOptions = { color: false },
): string {
  const lines = [
    dim("# oflow finish", presentation),
    "",
    "Story !" + result.story + " — " + statusMarker(result.ready ? "READY" : "NOT READY", presentation),
    "",
    "## Gates",
    "",
  ];
  for (const gate of result.gates) {
    lines.push("- [" + statusMarker(gate.passed ? "PASS" : "FAIL", presentation) + "] " + gate.id + " — " + gate.detail);
  }
  lines.push(
    "",
    "To close the story through the guarded path:",
    "  " + result.nextCommand,
  );
  if (result.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...result.warnings.map((warning) => "- " + warning));
  }
  return lines.join("\n") + "\n";
}

export interface HandoffResult {
  generatedAt: string;
  project: {
    host: string;
    path: string;
  };
  story: {
    iid: number;
    title: string;
    issueType: string | null;
    state: string | null;
    webUrl: string | null;
  };
  criteria: Array<{ id: string; status: string; evidence: string[] }>;
  mergeRequest: {
    iid: number;
    state: string | null;
    draft: boolean;
    webUrl: string | null;
  } | null;
  pipeline: { id: number; status: string | null } | null;
  local: {
    branch: string | null;
    clean: boolean;
    changedFiles: string[];
    recentCommits: string[];
  };
  blockers: string[];
  nextActions: string[];
}

/**
 * Compact handoff context for the next agent: everything needed to resume
 * work on the current story without re-deriving it from scratch.
 */
export async function handoffStory(options: FinishOptions): Promise<HandoffResult> {
  const { story } = await pickStory(options.root, options.story);
  const assessment = await assessStory(options.root, story.iid);
  const project = assessment.story.webUrl
    ? new URL(assessment.story.webUrl)
    : null;
  return {
    generatedAt: new Date().toISOString(),
    project: {
      host: project ? project.host : "",
      path: project ? project.pathname.split("/-/")[0].replace(/^\//, "") : "",
    },
    story: {
      iid: assessment.story.iid,
      title: assessment.story.title,
      issueType: assessment.story.issueType,
      state: assessment.story.state,
      webUrl: assessment.story.webUrl,
    },
    criteria: assessment.criteria.map((criterion) => ({
      id: criterion.id,
      status: criterion.status,
      evidence: criterion.evidence,
    })),
    mergeRequest: assessment.remote.mergeRequest
      ? {
          iid: assessment.remote.mergeRequest.iid,
          state: assessment.remote.mergeRequest.state,
          draft: assessment.remote.mergeRequest.draft,
          webUrl: assessment.remote.mergeRequest.webUrl,
        }
      : null,
    pipeline: assessment.remote.pipeline
      ? { id: assessment.remote.pipeline.id, status: assessment.remote.pipeline.status }
      : null,
    local: {
      branch: assessment.local.branch,
      clean: assessment.local.clean,
      changedFiles: assessment.local.changedFiles,
      recentCommits: assessment.local.recentCommits,
    },
    blockers: assessment.blockers,
    nextActions: assessment.nextActions,
  };
}

export function formatHandoffMarkdown(result: HandoffResult): string {
  const lines = [
    "# oflow handoff",
    "",
    "Story !" + result.story.iid + ": " + result.story.title,
    "State: " + (result.story.state ?? "unknown"),
    result.story.webUrl ? "URL: " + result.story.webUrl : "",
    "",
    "## Acceptance criteria",
    "",
  ].filter((line) => line !== "");
  if (result.criteria.length === 0) {
    lines.push("- (none parsed)");
  }
  for (const criterion of result.criteria) {
    lines.push("- " + criterion.id + ": " + criterion.status);
    for (const item of criterion.evidence) {
      lines.push("  evidence: " + item);
    }
  }
  lines.push(
    "",
    "Merge request: " + (result.mergeRequest
      ? "!" + result.mergeRequest.iid + " (" + result.mergeRequest.state + (result.mergeRequest.draft ? ", draft" : "") + ")"
      : "missing"),
    "Pipeline: " + (result.pipeline
      ? "#" + result.pipeline.id + " (" + (result.pipeline.status ?? "unknown") + ")"
      : "missing"),
    "Local: " + (result.local.branch ?? "(detached)") + (result.local.clean ? ", clean" : ", dirty (" + result.local.changedFiles.length + " changed)"),
  );
  if (result.local.recentCommits.length > 0) {
    lines.push("Recent commits:", ...result.local.recentCommits.map((commit) => "- " + commit));
  }
  if (result.blockers.length > 0) {
    lines.push("", "## Blockers", "", ...result.blockers.map((blocker) => "- " + blocker));
  }
  if (result.nextActions.length > 0) {
    lines.push("", "## Next actions", "", ...result.nextActions.map((action) => "- " + action));
  }
  return lines.join("\n") + "\n";
}
