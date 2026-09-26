import { getCurrentBranch, getGitLabRemote } from "./git.js";
import { loadConfig } from "./config.js";
import { parseAcceptanceCriteria } from "./criteria.js";
import { GitLabClient } from "./gitlab.js";
import type { GitLabListPage } from "./gitlab.js";
import { OflowError } from "./errors.js";
import { resolveAuth, type AuthResolution } from "./auth-resolver.js";
import type {
  GitLabIssue,
  GitLabIssueFilters,
  GitLabMergeRequest,
  GitLabNote,
  GitLabPipeline,
  GitLabUser,
  IssueState,
  StoryContext,
} from "./types.js";

export interface ContextReadResolution {
  client: GitLabClient;
  read: "rest" | "glab" | "graphql";
  host: string;
  sources: AuthResolution["sources"];
}

function notInstalled(): OflowError {
  return new OflowError(
    "No .oflow/config.json found. Run oflow install first.",
    "NOT_INSTALLED",
  );
}

export async function resolveContextRead(root: string): Promise<ContextReadResolution> {
  const config = await loadConfig(root);
  if (!config) throw notInstalled();
  const remote = await getGitLabRemote(root);
  if (remote.host !== config.project.host || remote.projectPath !== config.project.path) {
    throw new OflowError(
      "The current Git remote differs from .oflow/config.json.",
      "CONFIG_REMOTE_MISMATCH",
    );
  }
  const resolution = await resolveAuth({ host: remote.host, root });
  if (resolution.readBackend === "none") {
    throw new OflowError(
      "oflow cannot reach GitLab reads: no usable authentication backend. Run `oflow auth status` and `oflow doctor --check-api`.",
      "READ_TRANSPORT_UNAVAILABLE",
    );
  }
  return {
    client: new GitLabClient(remote.host),
    read: resolution.readBackend === "graphql" ? "graphql" : "rest",
    host: remote.host,
    sources: resolution.sources,
  };
}

export async function listWorkItems(
  root: string,
  state: IssueState = "opened",
  filters: GitLabIssueFilters = {},
  limit = 100,
): Promise<GitLabIssue[]> {
  return (await listWorkItemsPage(root, state, filters, limit)).items;
}

export async function listWorkItemsPage(
  root: string,
  state: IssueState = "opened",
  filters: GitLabIssueFilters = {},
  limit = 100,
): Promise<GitLabListPage<GitLabIssue>> {
  const resolution = await resolveContextRead(root);
  const remote = await getGitLabRemote(root);
  return resolution.client.listIssuesPage(remote.projectPath, state, limit, filters);
}

/**
 * Type-coverage census for a repository's GitLab project. REST `/issues`
 * lists only `issue` and `task` work-item types; the GraphQL project
 * work-item count sees all types. Returns null when either side is
 * unavailable (pagination headers absent or GraphQL unreachable): a missing
 * census is a skip, never evidence of full coverage.
 */
export async function workItemTypeCoverage(
  root: string,
  restTotal: number | null,
  state: IssueState = "all",
): Promise<{ graphqlCount: number; restTotal: number; hiddenCount: number } | null> {
  if (restTotal === null) return null;
  const config = await loadConfig(root);
  if (!config) return null;
  const remote = await getGitLabRemote(root);
  const graphqlCount = await new GitLabClient(remote.host)
    .countProjectWorkItems(remote.projectPath, state)
    .catch(() => null);
  if (graphqlCount === null) return null;
  return { graphqlCount, restTotal, hiddenCount: Math.max(0, graphqlCount - restTotal) };
}

export function formatWorkItemTypeCoverageWarning(
  coverage: { graphqlCount: number; restTotal: number; hiddenCount: number },
): string {
  return (
    "Type coverage: REST lists issue and task types only; " +
    coverage.hiddenCount +
    " of " +
    coverage.graphqlCount +
    " project work items are invisible to oflow's REST reads (custom types such as User Story or EPIC). " +
    "Listings and label-coverage audits are not complete for those items."
  );
}

export async function getCurrentGitLabUser(root: string): Promise<GitLabUser> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }

  const remote = await getGitLabRemote(root);
  return new GitLabClient(remote.host).getCurrentUser();
}

export async function loadMergeRequest(
  root: string,
  mergeRequestIid: number,
): Promise<GitLabMergeRequest> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  if (!Number.isSafeInteger(mergeRequestIid) || mergeRequestIid < 1) {
    throw new OflowError(
      "Merge request IID must be a positive integer.",
      "INVALID_MERGE_REQUEST_IID",
    );
  }

  const remote = await getGitLabRemote(root);
  return new GitLabClient(remote.host).getMergeRequest(remote.projectPath, mergeRequestIid);
}

/**
 * F6: one normalized read path per IID. REST `/issues/<iid>` is the single
 * source of truth for issue-backed work items; agents should not also probe
 * Work Item GraphQL endpoints for the same IID.
 */
export async function loadWorkItemByIid(
  root: string,
  iid: number,
): Promise<GitLabIssue> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  if (!Number.isSafeInteger(iid) || iid < 1) {
    throw new OflowError("Issue IID must be a positive integer.", "INVALID_ISSUE_IID");
  }
  const remote = await getGitLabRemote(root);
  return new GitLabClient(remote.host).getIssue(remote.projectPath, iid);
}

export interface MergeRequestSummary {
  iid: number;
  title: string;
  state: string | null;
  draft: boolean;
  author: string | null;
  assignees: string[];
  reviewers: string[];
  labels: string[];
  sourceBranch: string | null;
  targetBranch: string | null;
  mergeStatus: string | null;
  detailedMergeStatus: string | null;
  pipelineStatus: string | null;
  updatedAt: string | null;
  webUrl: string | null;
  description?: string | null;
}

export function compactMergeRequest(
  mergeRequest: GitLabMergeRequest,
  includeDescription = false,
): MergeRequestSummary {
  const summary: MergeRequestSummary = {
    iid: mergeRequest.iid,
    title: oneLine(mergeRequest.title),
    state: mergeRequest.state ?? null,
    draft: mergeRequest.draft === true,
    author: usernameFrom(mergeRequest.author),
    assignees: usernamesFrom(mergeRequest.assignees),
    reviewers: usernamesFrom(mergeRequest.reviewers),
    labels: mergeRequest.labels ?? [],
    sourceBranch: mergeRequest.source_branch ?? null,
    targetBranch: mergeRequest.target_branch ?? null,
    mergeStatus: mergeRequest.merge_status ?? null,
    detailedMergeStatus: mergeRequest.detailed_merge_status ?? null,
    pipelineStatus: isRecord(mergeRequest.pipeline)
      ? typeof mergeRequest.pipeline.status === "string"
        ? mergeRequest.pipeline.status
        : null
      : null,
    updatedAt: mergeRequest.updated_at ?? null,
    webUrl: mergeRequest.web_url ?? null,
  };
  if (includeDescription) {
    summary.description = mergeRequest.description ?? null;
  }
  return summary;
}

export function formatMergeRequestMarkdown(summary: MergeRequestSummary): string {
  const lines = [
    "# oflow mr",
    "",
    "MR !" + String(summary.iid) + ": " + summary.title,
    "State: " + (summary.state ?? "unknown") + (summary.draft ? " · draft" : ""),
    "Author: " + (summary.author ?? "unknown"),
    "Assignees: " + (summary.assignees.length > 0 ? summary.assignees.join(", ") : "none"),
    "Reviewers: " + (summary.reviewers.length > 0 ? summary.reviewers.join(", ") : "none"),
    "Labels: " + (summary.labels.length > 0 ? summary.labels.join(", ") : "none"),
    "Branch: " + (summary.sourceBranch ?? "unknown") + " -> " + (summary.targetBranch ?? "unknown"),
    "Merge status: " + (summary.detailedMergeStatus ?? summary.mergeStatus ?? "unknown"),
    "Pipeline: " + (summary.pipelineStatus ?? "unknown"),
    "Updated: " + (summary.updatedAt ?? "unknown"),
    "URL: " + (summary.webUrl ?? "unknown"),
  ];
  if (summary.description !== undefined) {
    lines.push("", "## Description", "", summary.description?.trim() || "_No description._");
  }
  return lines.join("\n") + "\n";
}

export interface WorkItemSummary {
  iid: number;
  title: string;
  state: string | null;
  issueType: string | null;
  labels: string[];
  milestone: string | null;
  iteration: string | null;
  assignees: string[];
  startDate: string | null;
  dueDate: string | null;
  weight: number | null;
  taskCompletion: {
    completed: number;
    total: number;
  } | null;
  parent: {
    iid: number | null;
    title: string;
    webUrl: string | null;
  } | null;
  updatedAt: string | null;
  webUrl: string | null;
}

export function compactWorkItems(issues: GitLabIssue[]): WorkItemSummary[] {
  return issues.map((issue) => ({
    iid: issue.iid,
    title: oneLine(issue.title),
    state: issue.state ?? null,
    issueType: typeof issue.issue_type === "string" ? issue.issue_type : null,
    labels: issue.labels ?? [],
    milestone: namedValue(issue.milestone),
    iteration: namedValue(issue.iteration),
    assignees: (issue.assignees ?? [])
      .map((assignee) => assignee.username ?? assignee.name)
      .filter((assignee): assignee is string => typeof assignee === "string"),
    startDate: issue.start_date ?? null,
    dueDate: issue.due_date ?? null,
    weight: issue.weight ?? null,
    taskCompletion: compactTaskCompletion(issue.task_completion_status),
    parent: compactParent(issue.parent ?? issue.epic),
    updatedAt: issue.updated_at ?? null,
    webUrl: issue.web_url ?? null,
  }));
}

export interface WorkItemsDisplayOptions {
  issueLimit: number;
  issueFilters: GitLabIssueFilters;
  mayBeTruncated: boolean;
  cache?: {
    source: "remote" | "sqlite";
    ageSeconds: number;
    actorUsername: string | null;
  };
}

export function formatWorkItemsMarkdown(
  issues: GitLabIssue[],
  state: IssueState,
  options?: WorkItemsDisplayOptions,
): string {
  return formatWorkItemSummariesMarkdown(compactWorkItems(issues), state, options);
}

export function formatWorkItemSummariesMarkdown(
  items: WorkItemSummary[],
  state: IssueState,
  options?: WorkItemsDisplayOptions,
): string {
  const query = options
    ? "Query: " + state +
      "; limit " + String(options.issueLimit) +
      (formatIssueFilters(options.issueFilters) || "")
    : "";
  const count = options?.mayBeTruncated
    ? "Count: " + String(items.length) + " (more may exist)"
    : "Count: " + String(items.length);
  const lines = [
    "# oflow work",
    "",
    "State: " + state,
    query,
    options?.cache
      ? "Source: " + (options.cache.source === "sqlite" ? "local SQLite cache" : "GitLab REST") +
        "; age " + formatCacheAge(options.cache.ageSeconds) +
        (options.cache.actorUsername ? "; user " + options.cache.actorUsername : "")
      : "",
    count,
    "",
  ];
  if (items.length === 0) {
    // An author or assignee filter that matched nothing is ambiguous: the
    // person may genuinely have no work, or the name may simply be wrong. A
    // wrong name is silent -- the same shape as "no work exists" -- so say so
    // rather than let the reader conclude the first.
    const identityFilter = options?.issueFilters.author ?? options?.issueFilters.assignee;
    lines.push(
      identityFilter === undefined
        ? "_No work items found._"
        : "_No work items found._ No " +
          (options?.issueFilters.author !== undefined ? "author" : "assignee") +
          " matched " + JSON.stringify(identityFilter) +
          "; check the name, or the person may simply have none.",
    );
  } else {
    lines.push(
      ...items.map((item) => {
        const title = item.webUrl
          ? "[" + oneLine(item.title) + "](" + item.webUrl + ")"
          : oneLine(item.title);
        const labels = item.labels.length > 0
          ? " · " + item.labels.join(", ")
          : "";
        const details = [
          labels.trim() ? labels.trim().replace(/^·\s*/, "") : "",
          item.issueType ? "type: " + item.issueType : "",
          item.assignees.length > 0 ? "assignee: " + item.assignees.join(", ") : "",
          item.milestone ? "milestone: " + item.milestone : "",
          item.iteration ? "iteration: " + item.iteration : "",
          item.taskCompletion ? "tasks: " + String(item.taskCompletion.completed) + "/" + String(item.taskCompletion.total) : "",
          item.weight !== null ? "weight: " + String(item.weight) : "",
        ].filter(Boolean);
        return "- #" + item.iid + " " + title +
          (details.length > 0 ? " · " + details.join(" · ") : "");
      }),
    );
  }
  lines.push(
    "",
    "Use oflow context --story <iid> for a complete story context.",
    "",
  );
  return lines.join("\n");
}

function formatCacheAge(seconds: number): string {
  if (seconds < 60) {
    return String(seconds) + "s";
  }
  if (seconds < 3600) {
    return String(Math.floor(seconds / 60)) + "m";
  }
  if (seconds < 86400) {
    return String(Math.floor(seconds / 3600)) + "h";
  }
  return String(Math.floor(seconds / 86400)) + "d";
}

function formatIssueFilters(filters: GitLabIssueFilters): string {
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => key + "=" + JSON.stringify(value));
  return entries.length > 0 ? "; filters: " + entries.join(", ") : "";
}

function namedValue(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = value.name ?? value.title;
  return typeof name === "string" && name.trim() ? oneLine(name) : null;
}

function compactTaskCompletion(value: unknown): WorkItemSummary["taskCompletion"] {
  if (!isRecord(value) || typeof value.count !== "number" ||
    typeof value.completed_count !== "number") {
    return null;
  }
  return {
    completed: value.completed_count,
    total: value.count,
  };
}

function usernameFrom(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const username = value.username ?? value.name;
  return typeof username === "string" && username.trim() ? username : null;
}

function usernamesFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .map(usernameFrom)
      .filter((username): username is string => username !== null)
    : [];
}

function compactParent(value: unknown): WorkItemSummary["parent"] {
  if (!isRecord(value)) {
    return null;
  }
  const title = value.title ?? value.name;
  if (typeof title !== "string" || !title.trim()) {
    return null;
  }
  const iid = typeof value.iid === "number"
    ? value.iid
    : typeof value.parent_iid === "number"
      ? value.parent_iid
      : null;
  return {
    iid,
    title: oneLine(title),
    webUrl: typeof value.web_url === "string" ? value.web_url : null,
  };
}

export async function loadStoryContext(
  root: string,
  storyIid: number,
): Promise<StoryContext> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }

  const remote = await getGitLabRemote(root);
  const warnings: string[] = [];
  if (
    config.project.host !== remote.host ||
    config.project.path !== remote.projectPath
  ) {
    warnings.push(
      "The current Git remote differs from .oflow/config.json; using the current remote.",
    );
  }

  const client = new GitLabClient(remote.host);
  const [project, story] = await Promise.all([
    client.getProject(remote.projectPath),
    client.getIssue(remote.projectPath, storyIid),
  ]);
  const branch = await getCurrentBranch(root);

  const [recentNotes, mergeRequests, pipelines] = await Promise.all([
    optionalFetch<GitLabNote[]>(
      () => client.getIssueNotes(remote.projectPath, storyIid),
      "Could not read story notes",
      warnings,
    ),
    optionalFetch<GitLabMergeRequest[]>(
      () => client.listRelatedMergeRequests(remote.projectPath, storyIid),
      "Could not read related merge requests",
      warnings,
    ),
    optionalFetch<GitLabPipeline[]>(
      () => client.listPipelines(remote.projectPath, branch),
      "Could not read pipelines",
      warnings,
    ),
  ]);

  const verificationMergeRequest = chooseVerificationMergeRequest({
    branch,
    mergeRequests,
  });
  const mergeRequestPipelines = verificationMergeRequest
    ? await optionalFetch<GitLabPipeline[]>(
      () => client.listMergeRequestPipelines(
        remote.projectPath,
        verificationMergeRequest.iid,
      ),
      "Could not read merge request pipelines",
      warnings,
    )
    : [];

  const criteria = parseAcceptanceCriteria(story.description);
  const epic = normalizeEpic(story);
  if (criteria.length === 0) {
    warnings.push("Story has no Acceptance criteria checklist.");
  }
  if (mergeRequests.length === 0) {
    warnings.push("No merge request references this story yet.");
  }
  if (
    pipelines.length === 0 &&
    mergeRequestPipelines.length === 0 &&
    mergeRequests.length === 0
  ) {
    warnings.push("No pipeline was found for the current branch.");
  }

  const verificationEvidence = selectVerificationEvidence({
    branch,
    mergeRequests,
    mergeRequestPipelines,
  });
  if (verificationEvidence.warning) {
    warnings.push(verificationEvidence.warning);
  }

  return {
    generatedAt: new Date().toISOString(),
    branch,
    project,
    story: {
      ...story,
      web_url:
        story.web_url ??
        project.web_url + "/-/issues/" + String(storyIid),
    },
    epic,
    criteria,
    mergeRequests,
    pipelines,
    mergeRequestPipelines,
    recentNotes: recentNotes.slice(0, 20),
    warnings,
  };
}

export function formatContextMarkdown(context: StoryContext): string {
  const storyUrl = context.story.web_url
    ? "[" + context.story.title + "](" + context.story.web_url + ")"
    : context.story.title;
  const lines = [
    "# oflow context",
    "",
    "Generated: " + context.generatedAt,
    "Project: [" +
      context.project.path_with_namespace +
      "](" +
      context.project.web_url +
      ")",
    "Branch: " + (context.branch ?? "detached/unknown"),
    "",
    "## Story #" + context.story.iid,
    "",
    storyUrl,
    "",
    "State: " + (context.story.state ?? "unknown"),
    "",
    context.story.description?.trim() || "_No description._",
    "",
    "## Epic / parent",
    "",
    formatParent(context.epic),
    "",
    "## Acceptance criteria",
    "",
  ];

  if (context.criteria.length === 0) {
    lines.push("_No acceptance criteria found._");
  } else {
    lines.push(
      ...context.criteria.map(
        (criterion) =>
          "- [" +
          (criterion.checked ? "x" : " ") +
          "] " +
          criterion.id +
          ": " +
          criterion.text,
      ),
    );
  }

  lines.push("", "## Related merge requests", "");
  if (context.mergeRequests.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push(
      ...context.mergeRequests.map(
        (mergeRequest) =>
          "- ! " +
          mergeRequest.iid +
          " " +
          (mergeRequest.web_url
            ? "[" + mergeRequest.title + "](" + mergeRequest.web_url + ")"
            : mergeRequest.title) +
          " (" +
          (mergeRequest.state ?? "unknown") +
          ")",
      ),
    );
  }

  lines.push("", "## Pipelines", "");
  if (context.pipelines.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push(
      ...context.pipelines.slice(0, 10).map(
        (pipeline) =>
          "- #" +
          pipeline.id +
          ": " +
          (pipeline.status ?? "unknown") +
          (pipeline.web_url
            ? " [" + pipeline.web_url + "](" + pipeline.web_url + ")"
            : ""),
      ),
    );
  }

  lines.push("", "## Merge-request pipelines", "");
  if (!context.mergeRequestPipelines || context.mergeRequestPipelines.length === 0) {
    lines.push("_None found or no single merge request could be selected._");
  } else {
    lines.push(
      ...context.mergeRequestPipelines.slice(0, 10).map(
        (pipeline) =>
          "- #" +
          pipeline.id +
          ": " +
          (pipeline.status ?? "unknown") +
          (pipeline.sha ? " (" + pipeline.sha.slice(0, 12) + ")" : "") +
          (pipeline.web_url
            ? " [" + pipeline.web_url + "](" + pipeline.web_url + ")"
            : ""),
      ),
    );
  }

  lines.push("", "## Recent notes", "");
  if (context.recentNotes.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push(
      ...context.recentNotes.slice(0, 10).map(
        (note) =>
          "- " +
          (note.created_at ?? "unknown date") +
          ": " +
          oneLine(note.body),
      ),
    );
  }

  if (context.warnings.length > 0) {
    lines.push(
      "",
      "## Warnings",
      "",
      ...context.warnings.map((warning) => "- " + warning),
    );
  }
  lines.push(
    "",
    "## Next action",
    "",
    context.mergeRequests.length === 0
      ? "Create an MR from the story and use oflow mr --story " + context.story.iid + " for its description."
      : "Refresh this context, complete the MR evidence checklist, then run oflow verify --story " + context.story.iid + ".",
    "",
  );
  return lines.join("\n");
}

export function chooseMergeRequest(context: StoryContext): GitLabMergeRequest | null {
  if (context.mergeRequests.length === 0) {
    return null;
  }
  if (context.branch) {
    const branchMatch = context.mergeRequests.find(
      (mergeRequest) => mergeRequest.source_branch === context.branch,
    );
    if (branchMatch) {
      return branchMatch;
    }
  }
  return context.mergeRequests[0];
}

export function chooseVerificationMergeRequest(
  context: Pick<StoryContext, "branch" | "mergeRequests">,
): GitLabMergeRequest | null {
  if (context.mergeRequests.length === 0) {
    return null;
  }
  if (context.branch) {
    const branchMatches = context.mergeRequests.filter(
      (mergeRequest) => mergeRequest.source_branch === context.branch,
    );
    if (branchMatches.length === 1) {
      return branchMatches[0];
    }
    if (branchMatches.length > 1) {
      return null;
    }
  }
  return context.mergeRequests.length === 1 ? context.mergeRequests[0] : null;
}

export interface VerificationEvidence {
  mergeRequest: GitLabMergeRequest | null;
  pipeline: GitLabPipeline | null;
  warning: string | null;
}

type VerificationContext = Pick<StoryContext, "branch" | "mergeRequests"> & {
  mergeRequestPipelines?: GitLabPipeline[];
};

export function selectVerificationEvidence(context: VerificationContext): VerificationEvidence {
  const mergeRequest = chooseVerificationMergeRequest(context);
  if (!mergeRequest) {
    return {
      mergeRequest: null,
      pipeline: null,
      warning: context.mergeRequests.length > 0
        ? "Could not identify one related merge request for the current branch; pipeline verification is unavailable."
        : null,
    };
  }

  const expectedSha = mergeRequestHeadSha(mergeRequest);
  const pipelines = context.mergeRequestPipelines ?? [];
  const pipeline = pipelines.find((candidate) => pipelineMatchesSha(candidate, expectedSha)) ?? null;
  return {
    mergeRequest,
    pipeline,
    warning: pipeline
      ? null
      : expectedSha
        ? "No merge request pipeline matches the selected merge request head SHA; pipeline verification is unavailable."
        : "No pipeline was found for merge request !" + String(mergeRequest.iid) + "; pipeline verification is unavailable.",
  };
}

function mergeRequestHeadSha(mergeRequest: GitLabMergeRequest): string | null {
  if (typeof mergeRequest.sha === "string" && mergeRequest.sha) {
    return mergeRequest.sha;
  }
  const headSha = mergeRequest.diff_refs?.head_sha;
  return typeof headSha === "string" && headSha ? headSha : null;
}

function pipelineMatchesSha(
  pipeline: GitLabPipeline,
  expectedSha: string | null,
): boolean {
  return expectedSha === null || pipeline.sha === expectedSha;
}

export function formatMergeRequestTemplate(context: StoryContext): string {
  const criteria = context.criteria.length === 0
    ? "- [ ] AC-1: Add the story's acceptance criteria before opening this MR.\n  Evidence: TBD"
    : context.criteria
        .map(
          (criterion) =>
            "- [ ] " +
            criterion.id +
            ": " +
            criterion.text +
            "\n  Evidence: TBD",
        )
        .join("\n");
  return [
    "# Summary",
    "",
    "Implements story #" + context.story.iid + ": " + context.story.title,
    "",
    "## Acceptance criteria verification",
    "",
    criteria,
    "",
    "## Implementation notes",
    "",
    "- Describe the important implementation choices.",
    "- Link tests, screenshots, logs, or other concrete evidence above.",
    "",
    "Closes #" + context.story.iid,
    "",
  ].join("\n");
}

async function optionalFetch<T>(
  operation: () => Promise<T>,
  label: string,
  warnings: string[],
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(label + ": " + message);
    return ([] as unknown) as T;
  }
}

function normalizeEpic(
  issue: Record<string, unknown>,
): Record<string, unknown> | null {
  const candidates = [
    issue.epic,
    issue.parent,
    issue.work_item_parent,
    issue.parent_work_item,
  ];
  return candidates.find(isRecord) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatParent(parent: Record<string, unknown> | null): string {
  if (!parent) {
    return "_No epic or parent returned by GitLab._";
  }
  const title = String(parent.title ?? parent.name ?? "Untitled parent");
  const webUrl = typeof parent.web_url === "string" ? parent.web_url : null;
  const iid = parent.iid ? " #" + String(parent.iid) : "";
  return webUrl ? "[" + title + iid + "](" + webUrl + ")" : title + iid;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
