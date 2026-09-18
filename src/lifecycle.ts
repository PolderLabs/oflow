/**
 * Agent lifecycle commands (vNext architecture, PR 8-9).
 *
 * `oflow start` composes work selection, story context, assessment, and
 * execution-backend resolution into one compact agent entry point.
 * `oflow check` unifies local git state, story assessment, MR/pipeline
 * evidence, and policy into a single next-action summary.
 *
 * Both are compositions over existing primitives; they add no new remote
 * calls beyond what `work --mine`/`context`/`assess` already make.
 */

import { assessStory } from "./assess.js";
import { resolveAuth } from "./auth-resolver.js";
import { compactWorkItems, getCurrentGitLabUser, listWorkItems } from "./context.js";
import { OflowError } from "./errors.js";
import { getCurrentBranch } from "./git.js";
import { loadStoryContext } from "./context.js";
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
  nextAction: string;
  warnings: string[];
}

export async function checkStory(options: CheckOptions): Promise<CheckResult> {
  const { story, reason } = await pickStory(options.root, options.story);
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
    nextAction,
    warnings: [
      ...assessment.warnings,
      ...("selected because: " + reason ? [] : []),
    ],
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
