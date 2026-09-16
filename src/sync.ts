import { getCurrentBranch, getGitLabRemote } from "./git.js";
import { loadConfig } from "./config.js";
import { parseAcceptanceCriteria } from "./criteria.js";
import { GitLabClient } from "./gitlab.js";
import { OflowError } from "./errors.js";
import type {
  GitLabBoard,
  GitLabBoardList,
  GitLabIssue,
  GitLabIteration,
  GitLabLabel,
  GitLabMergeRequest,
  GitLabMilestone,
  GitLabPipeline,
  GitLabProject,
  IssueState,
} from "./types.js";

export interface SyncOptions {
  state?: IssueState;
  storyIid?: number;
}

export interface SyncResult {
  generatedAt: string;
  project: {
    id: number;
    path: string;
    webUrl: string;
    defaultBranch: string | null;
  };
  repository: {
    branch: string | null;
    groupPath: string | null;
  };
  workItems: SyncWorkItem[];
  mergeRequests: SyncMergeRequest[];
  pipelines: SyncPipeline[];
  planning: {
    labels: SyncLabel[];
    milestones: SyncMilestone[];
    boards: SyncBoard[];
    iterations: SyncIteration[];
  };
  story: SyncStory | null;
  stats: {
    workItems: number;
    mergeRequests: number;
    pipelines: number;
    labels: number;
    milestones: number;
    boards: number;
    iterations: number;
  };
  warnings: string[];
}

export interface SyncWorkItem {
  iid: number;
  title: string;
  state: string | null;
  labels: string[];
  milestone: string | null;
  iteration: string | null;
  updatedAt: string | null;
  webUrl: string | null;
}

export interface SyncMergeRequest {
  iid: number;
  title: string;
  state: string | null;
  draft: boolean;
  sourceBranch: string | null;
  targetBranch: string | null;
  updatedAt: string | null;
  webUrl: string | null;
}

export interface SyncPipeline {
  id: number;
  status: string | null;
  ref: string | null;
  sha: string | null;
  updatedAt: string | null;
  webUrl: string | null;
}

export interface SyncLabel {
  name: string;
  color: string | null;
  openIssues: number | null;
  closedIssues: number | null;
  openMergeRequests: number | null;
}

export interface SyncMilestone {
  iid: number;
  title: string;
  state: string | null;
  startDate: string | null;
  dueDate: string | null;
  webUrl: string | null;
}

export interface SyncBoard {
  id: number;
  name: string;
  lists: Array<{
    id: number;
    label: string | null;
    position: number | null;
  }>;
}

export interface SyncIteration {
  iid: number;
  title: string | null;
  state: string | null;
  startDate: string | null;
  dueDate: string | null;
  webUrl: string | null;
}

export interface SyncStory {
  iid: number;
  title: string;
  state: string | null;
  labels: string[];
  milestone: string | null;
  iteration: string | null;
  updatedAt: string | null;
  webUrl: string | null;
  acceptanceCriteria: Array<{
    id: string;
    text: string;
    checked: boolean;
  }>;
  mergeRequests: SyncMergeRequest[];
  pipelines: SyncPipeline[];
  recentNotes: number;
  notes: SyncNote[];
}

export interface SyncNote {
  id: number;
  body: string;
  createdAt: string | null;
  author: string | null;
}

export async function syncProject(
  root: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }

  const remote = await getGitLabRemote(root);
  const branch = await getCurrentBranch(root);
  const groupPath = parentGroupPath(remote.projectPath);
  const state = options.state ?? "opened";
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
  const project = await client.getProject(remote.projectPath);
  const [issues, mergeRequests, pipelines, labels, milestones, boards, iterations] =
    await Promise.all([
      optionalFetch(
        () => client.listIssues(remote.projectPath, state, 50),
        "Could not read work items",
        warnings,
      ),
      optionalFetch(
        () => client.listMergeRequests(remote.projectPath, undefined, "opened", 20),
        "Could not read merge requests",
        warnings,
      ),
      optionalFetch(
        () => client.listPipelines(remote.projectPath, branch, 10),
        "Could not read pipelines",
        warnings,
      ),
      optionalFetch(
        () => client.listLabels(remote.projectPath, 100),
        "Could not read project labels",
        warnings,
      ),
      optionalFetch(
        () => client.listMilestones(remote.projectPath, "active", 100),
        "Could not read project milestones",
        warnings,
      ),
      optionalFetch(
        () => loadBoards(client, remote.projectPath),
        "Could not read project boards",
        warnings,
      ),
      optionalFetch(
        () => client.listProjectIterations(remote.projectPath, "all", 100),
        "Could not read project iterations",
        warnings,
      ),
    ]);

  const story = options.storyIid
    ? await loadStorySummary(
        client,
        remote.projectPath,
        options.storyIid,
        branch,
        warnings,
      )
    : null;

  const result: SyncResult = {
    generatedAt: new Date().toISOString(),
    project: compactProject(project),
    repository: { branch, groupPath },
    workItems: issues.map(compactWorkItem),
    mergeRequests: mergeRequests.map(compactMergeRequest),
    pipelines: pipelines.map(compactPipeline),
    planning: {
      labels: labels.map(compactLabel),
      milestones: milestones.map(compactMilestone),
      boards,
      iterations: iterations.map(compactIteration),
    },
    story,
    stats: {
      workItems: issues.length,
      mergeRequests: mergeRequests.length,
      pipelines: pipelines.length,
      labels: labels.length,
      milestones: milestones.length,
      boards: boards.length,
      iterations: iterations.length,
    },
    warnings,
  };
  return result;
}

export function formatSyncMarkdown(result: SyncResult): string {
  const lines = [
    "# oflow sync",
    "",
    "Generated: " + result.generatedAt,
    "Project: [" + result.project.path + "](" + result.project.webUrl + ")",
    "Branch: " + (result.repository.branch ?? "detached/unknown"),
    "",
    "## Snapshot",
    "",
    "- Work items: " + String(result.stats.workItems),
    "- Open merge requests: " + String(result.stats.mergeRequests),
    "- Pipelines: " + String(result.stats.pipelines),
    "- Labels: " + String(result.stats.labels),
    "- Active milestones: " + String(result.stats.milestones),
    "- Boards: " + String(result.stats.boards),
    "- Project-visible iterations: " + String(result.stats.iterations),
    "",
    "## Current work items",
    "",
  ];

  if (result.workItems.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push(
      ...result.workItems.slice(0, 20).map(
        (item) =>
          "- #" +
          item.iid +
          " " +
          linkOrText(item.title, item.webUrl) +
          (item.labels.length > 0 ? " · " + item.labels.join(", ") : "") +
          (item.milestone ? " · milestone: " + item.milestone : "") +
          (item.iteration ? " · iteration: " + item.iteration : ""),
      ),
    );
  }

  lines.push("", "## Open merge requests", "");
  if (result.mergeRequests.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push(
      ...result.mergeRequests.slice(0, 20).map(
        (mergeRequest) =>
          "- !" +
          mergeRequest.iid +
          " " +
          linkOrText(mergeRequest.title, mergeRequest.webUrl) +
          " (" +
          (mergeRequest.draft ? "draft, " : "") +
          (mergeRequest.sourceBranch ?? "unknown source") +
          " -> " +
          (mergeRequest.targetBranch ?? "unknown target") +
          ")",
      ),
    );
  }

  lines.push("", "## Planning", "");
  lines.push(
    "Labels: " +
      (result.planning.labels.length > 0
        ? result.planning.labels.map((label) => label.name).join(", ")
        : "none"),
    "Milestones: " +
      (result.planning.milestones.length > 0
        ? result.planning.milestones.map((milestone) => milestone.title).join(", ")
        : "none"),
    "Boards: " +
      (result.planning.boards.length > 0
        ? result.planning.boards
            .map((board) => board.name + " (" + board.lists.length + " lists)")
            .join(", ")
        : "none"),
    "Iterations: " +
      (result.planning.iterations.length > 0
        ? result.planning.iterations
            .map((iteration) => iteration.title ?? "iteration #" + iteration.iid)
            .join(", ")
        : "none"),
  );

  if (result.story) {
    lines.push(
      "",
      "## Story #" + result.story.iid,
      "",
      linkOrText(result.story.title, result.story.webUrl),
      "State: " + (result.story.state ?? "unknown"),
      "Acceptance criteria: " + String(result.story.acceptanceCriteria.length),
      "Related merge requests: " + String(result.story.mergeRequests.length),
      "Recent notes: " + String(result.story.recentNotes),
    );
    if (result.story.notes.length > 0) {
      lines.push(
        "",
        ...result.story.notes.map(
          (note) =>
            "- " +
            note.body +
            (note.author ? " (" + note.author + ")" : ""),
        ),
      );
    }
  }

  if (result.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...result.warnings.map((warning) => "- " + warning));
  }
  lines.push(
    "",
    "Use `oflow sync --json` for the compact agent handoff or `oflow context --story <iid>` for full story evidence.",
    "",
  );
  return lines.join("\n");
}

async function loadStorySummary(
  client: GitLabClient,
  projectPath: string,
  storyIid: number,
  branch: string | null,
  warnings: string[],
): Promise<SyncStory> {
  const [issue, notes, mergeRequests, pipelines] = await Promise.all([
    client.getIssue(projectPath, storyIid),
    optionalFetch(
      () => client.getIssueNotes(projectPath, storyIid),
      "Could not read story notes",
      warnings,
    ),
    optionalFetch(
      () => client.listRelatedMergeRequests(projectPath, storyIid, 20),
      "Could not read story merge requests",
      warnings,
    ),
    optionalFetch(
      () => client.listPipelines(projectPath, branch, 10),
      "Could not read story pipelines",
      warnings,
    ),
  ]);
  const criteria = parseAcceptanceCriteria(issue.description);
  if (criteria.length === 0) {
    warnings.push("Story has no Acceptance criteria checklist.");
  }
  return {
    iid: issue.iid,
    title: oneLine(issue.title),
    state: issue.state ?? null,
    labels: issue.labels ?? [],
    milestone: namedValue(issue.milestone),
    iteration: namedValue(issue.iteration),
    updatedAt: issue.updated_at ?? null,
    webUrl: issue.web_url ?? null,
    acceptanceCriteria: criteria,
    mergeRequests: mergeRequests.map(compactMergeRequest),
    pipelines: pipelines.map(compactPipeline),
    recentNotes: notes.length,
    notes: notes.slice(0, 5).map(compactNote),
  };
}

async function loadBoards(
  client: GitLabClient,
  projectPath: string,
): Promise<SyncBoard[]> {
  const boards = await client.listBoards(projectPath, 100);
  return Promise.all(
    boards.map(async (board) => ({
      id: board.id,
      name: oneLine(board.name),
      lists: (await client.listBoardLists(projectPath, board.id, 100)).map(
        (list) => ({
          id: list.id,
          label: list.label?.name ?? null,
          position: list.position ?? null,
        }),
      ),
    })),
  );
}

function compactProject(project: GitLabProject): SyncResult["project"] {
  return {
    id: project.id,
    path: project.path_with_namespace,
    webUrl: project.web_url,
    defaultBranch: project.default_branch ?? null,
  };
}

function compactWorkItem(issue: GitLabIssue): SyncWorkItem {
  return {
    iid: issue.iid,
    title: oneLine(issue.title),
    state: issue.state ?? null,
    labels: issue.labels ?? [],
    milestone: namedValue(issue.milestone),
    iteration: namedValue(issue.iteration),
    updatedAt: issue.updated_at ?? null,
    webUrl: issue.web_url ?? null,
  };
}

function compactMergeRequest(mergeRequest: GitLabMergeRequest): SyncMergeRequest {
  return {
    iid: mergeRequest.iid,
    title: oneLine(mergeRequest.title),
    state: mergeRequest.state ?? null,
    draft: Boolean(mergeRequest.draft),
    sourceBranch: mergeRequest.source_branch ?? null,
    targetBranch: mergeRequest.target_branch ?? null,
    updatedAt: mergeRequest.updated_at ?? null,
    webUrl: mergeRequest.web_url ?? null,
  };
}

function compactPipeline(pipeline: GitLabPipeline): SyncPipeline {
  return {
    id: pipeline.id,
    status: pipeline.status ?? null,
    ref: pipeline.ref ?? null,
    sha: pipeline.sha ?? null,
    updatedAt: pipeline.updated_at ?? null,
    webUrl: pipeline.web_url ?? null,
  };
}

function compactLabel(label: GitLabLabel): SyncLabel {
  return {
    name: label.name,
    color: label.color ?? null,
    openIssues: label.open_issues_count ?? null,
    closedIssues: label.closed_issues_count ?? null,
    openMergeRequests: label.open_merge_requests_count ?? null,
  };
}

function compactMilestone(milestone: GitLabMilestone): SyncMilestone {
  return {
    iid: milestone.iid,
    title: oneLine(milestone.title),
    state: milestone.state ?? null,
    startDate: milestone.start_date ?? null,
    dueDate: milestone.due_date ?? null,
    webUrl: typeof milestone.web_url === "string" ? milestone.web_url : null,
  };
}

function compactIteration(iteration: GitLabIteration): SyncIteration {
  return {
    iid: iteration.iid,
    title: iteration.title ? oneLine(iteration.title) : null,
    state: iteration.state ?? null,
    startDate: iteration.start_date ?? null,
    dueDate: iteration.due_date ?? null,
    webUrl: iteration.web_url ?? null,
  };
}

function compactNote(note: {
  id: number;
  body: string;
  created_at?: string;
  author?: Record<string, unknown> | null;
}): SyncNote {
  const author = note.author?.username ?? note.author?.name;
  return {
    id: note.id,
    body: oneLine(note.body).slice(0, 280),
    createdAt: note.created_at ?? null,
    author: typeof author === "string" ? author : null,
  };
}

async function optionalFetch<T>(
  operation: () => Promise<T>,
  label: string,
  warnings: string[],
  fallback?: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    warnings.push(label + ": " + (error instanceof Error ? error.message : String(error)));
    return fallback ?? ([] as unknown as T);
  }
}

function parentGroupPath(projectPath: string): string | null {
  const separator = projectPath.lastIndexOf("/");
  return separator > 0 ? projectPath.slice(0, separator) : null;
}

function namedValue(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = record.name ?? record.title;
  return typeof name === "string" && name.trim() ? oneLine(name) : null;
}

function linkOrText(value: string, url: string | null): string {
  return url ? "[" + value + "](" + url + ")" : value;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
