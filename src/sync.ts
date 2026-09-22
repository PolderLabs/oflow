import { getCurrentBranch, getGitLabRemote } from "./git.js";
import {
  readSyncCache,
  SYNC_CACHE_RELATIVE_PATH,
  SYNC_CACHE_VERSION,
  writeSyncCache,
  type SyncCacheEnvelope,
} from "./cache.js";
import { loadConfig } from "./config.js";
import { parseAcceptanceCriteria } from "./criteria.js";
import { GitLabClient } from "./gitlab.js";
import type { GitLabListPage, GitLabPagination } from "./gitlab.js";
import { formatWorkItemTypeCoverageWarning } from "./context.js";
import { OflowError } from "./errors.js";
import { saveSyncReadModel } from "./read-model.js";
import type {
  GitLabBoard,
  GitLabBoardList,
  GitLabGroupEpic,
  GitLabIssue,
  GitLabIssueFilters,
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
  issueFilters?: GitLabIssueFilters;
  issueLimit?: number;
  includeEpics?: boolean;
  staleDays?: number;
  cache?: SyncCacheMode;
}

export type SyncCacheMode = "refresh" | "cached";

export interface SyncResult {
  generatedAt: string;
  cache: {
    source: "remote" | "cache";
    savedAt: string;
    ageSeconds: number;
  };
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
  workItemsMayBeTruncated: boolean;
  query: {
    state: IssueState;
    issueLimit: number;
    issueFilters: GitLabIssueFilters;
    includeEpics: boolean;
    staleDays: number | null;
  };
  mergeRequests: SyncMergeRequest[];
  pipelines: SyncPipeline[];
  planning: {
    labels: SyncLabel[];
    milestones: SyncMilestone[];
    boards: SyncBoard[];
    iterations: SyncIteration[];
    epics: SyncEpic[];
    epicsMayBeTruncated: boolean;
  };
  pagination: {
    workItems: GitLabPagination;
    mergeRequests: GitLabPagination;
    pipelines: GitLabPagination;
    labels: GitLabPagination;
    milestones: GitLabPagination;
    boards: GitLabPagination;
    boardLists: Array<{ boardId: number; pagination: GitLabPagination }>;
    iterations: GitLabPagination;
    epics: GitLabPagination;
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
    epics: number;
  };
  planningHealth: SyncPlanningHealth;
  warnings: string[];
}

export interface SyncSummary {
  generatedAt: string;
  cache: SyncResult["cache"];
  project: SyncResult["project"];
  repository: SyncResult["repository"];
  query: SyncResult["query"];
  workItems: Array<Pick<SyncWorkItem, "iid" | "title" | "state" | "labels" | "milestone" | "iteration" | "assignees" | "taskCompletion" | "updatedAt" | "webUrl">>;
  workItemsMayBeTruncated: boolean;
  mergeRequests: Array<Pick<SyncMergeRequest, "iid" | "title" | "state" | "draft" | "sourceBranch" | "targetBranch" | "webUrl">>;
  pipelines: Array<Pick<SyncPipeline, "id" | "status" | "ref" | "sha" | "webUrl">>;
  planning: {
    labels: string[];
    milestones: Array<Pick<SyncMilestone, "iid" | "title" | "state" | "startDate" | "dueDate">>;
    boards: Array<{
      id: number;
      name: string;
      lists: string[];
    }>;
    iterations: Array<Pick<SyncIteration, "iid" | "title" | "state" | "startDate" | "dueDate">>;
    epicCount: number;
    epicsMayBeTruncated: boolean;
  };
  story: {
    iid: number;
    title: string;
    state: string | null;
    labels: string[];
    milestone: string | null;
    iteration: string | null;
    assignees: string[];
    taskCompletion: SyncStory["taskCompletion"];
    acceptanceCriteria: number;
    mergeRequests: number;
    pipelines: number;
    recentNotes: number;
    webUrl: string | null;
  } | null;
  stats: SyncResult["stats"];
  planningHealth: SyncPlanningHealth;
  warnings: string[];
}

export interface SyncPlanningHealth {
  findings: Array<{
    code:
      | "missing-acceptance-criteria"
      | "unassigned-work-item"
      | "untimeboxed-work-item"
      | "stale-work-item"
      | "conflicting-board-labels";
    message: string;
    storyIids: number[];
  }>;
}

export interface SyncWorkItem {
  iid: number;
  title: string;
  state: string | null;
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
  parent: SyncParent | null;
  updatedAt: string | null;
  webUrl: string | null;
}

export interface SyncParent {
  title: string;
  iid: number | null;
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

interface LoadedBoards {
  boards: SyncBoard[];
  pagination: GitLabPagination;
  boardLists: Array<{ boardId: number; pagination: GitLabPagination }>;
}

interface SyncCacheQuery {
  state: IssueState;
  storyIid: number | null;
  issueFilters: GitLabIssueFilters;
  issueLimit: number;
  includeEpics: boolean;
  staleDays: number | null;
}

export interface SyncIteration {
  iid: number;
  title: string | null;
  state: string | null;
  startDate: string | null;
  dueDate: string | null;
  webUrl: string | null;
}

export interface SyncEpic {
  iid: number;
  title: string;
  state: string | null;
  webUrl: string | null;
}

export interface SyncStory {
  iid: number;
  title: string;
  state: string | null;
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
  parent: SyncParent | null;
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
  const state = options.state ?? "opened";
  const issueLimit = options.issueLimit ?? 50;
  const issueFilters = options.issueFilters ?? {};
  const staleDays = validateStaleDays(options.staleDays);
  const cacheMode = validateCacheMode(options.cache);
  const cacheQuery = createCacheQuery({
    state,
    storyIid: options.storyIid ?? null,
    issueFilters,
    issueLimit,
    includeEpics: options.includeEpics === true,
    staleDays,
  });
  const warnings: string[] = [];

  if (
    config.project.host !== remote.host ||
    config.project.path !== remote.projectPath
  ) {
    warnings.push(
      "The current Git remote differs from .oflow/config.json; using the current remote.",
    );
  }

  if (cacheMode === "cached") {
    return await loadCachedSync(
      root,
      remote.host,
      remote.projectPath,
      branch,
      cacheQuery,
      warnings,
    );
  }

  const client = new GitLabClient(remote.host);
  const project = await client.getProject(remote.projectPath);
  const groupPath = projectNamespacePath(project) ?? parentGroupPath(remote.projectPath);
  const emptyEpicPage = { epics: [] as GitLabGroupEpic[], mayBeTruncated: false };
  const emptyBoardsPage: LoadedBoards = {
    boards: [],
    pagination: emptyPagination(100),
    boardLists: [],
  };
  const [issuesPage, mergeRequestsPage, pipelinesPage, labelsPage, milestonesPage, boardsPage, iterationsPage, groupEpics] =
    await Promise.all([
      optionalFetch(
        () => client.listIssuesPage(
          remote.projectPath,
          state,
          issueLimit,
          issueFilters,
        ),
        "Could not read work items",
        warnings,
        emptyListPage(issueLimit),
      ),
      optionalFetch(
        () => client.listMergeRequestsPage(remote.projectPath, undefined, "opened", 20),
        "Could not read merge requests",
        warnings,
        emptyListPage(20),
      ),
      optionalFetch(
        () => client.listPipelinesPage(remote.projectPath, branch, 10),
        "Could not read pipelines",
        warnings,
        emptyListPage(10),
      ),
      optionalFetch(
        () => client.listLabelsPage(remote.projectPath, 100),
        "Could not read project labels",
        warnings,
        emptyListPage(100),
      ),
      optionalFetch(
        () => client.listMilestonesPage(remote.projectPath, "active", 100),
        "Could not read project milestones",
        warnings,
        emptyListPage(100),
      ),
      optionalFetch(
        () => loadBoards(client, remote.projectPath),
        "Could not read project boards",
        warnings,
        emptyBoardsPage,
      ),
      optionalFetch(
        () => client.listProjectIterationsPage(remote.projectPath, "all", 100),
        "Could not read project iterations",
        warnings,
        emptyListPage(100),
      ),
      options.includeEpics === true && groupPath
        ? optionalFetch(
          () => client.listGroupEpics(groupPath, 50),
          "Could not read group epics",
          warnings,
          emptyEpicPage,
        )
        : Promise.resolve(emptyEpicPage),
    ]);

  // Type-coverage census: same contract as the work command. REST /issues
  // lists only issue+task types, so a board using custom types would make
  // planning-health reads claim completeness they do not have. Unfiltered
  // queries only: the GraphQL count is project-wide.
  if (!Object.values(issueFilters).some((value) => value !== undefined)) {
    const graphqlCount = await client
      .countProjectWorkItems(remote.projectPath, state)
      .catch(() => null);
    if (
      graphqlCount !== null &&
      issuesPage.pagination.total !== null &&
      graphqlCount > issuesPage.pagination.total
    ) {
      warnings.push(
        formatWorkItemTypeCoverageWarning({
          graphqlCount,
          restTotal: issuesPage.pagination.total,
          hiddenCount: graphqlCount - issuesPage.pagination.total,
        }),
      );
    }
  }

  const story = options.storyIid
    ? await loadStorySummary(
        client,
        remote.projectPath,
        options.storyIid,
        branch,
        warnings,
        pipelinesPage.items,
      )
      : null;

  const generatedAt = new Date().toISOString();
  const result: SyncResult = {
    generatedAt,
    cache: {
      source: "remote",
      savedAt: generatedAt,
      ageSeconds: 0,
    },
    project: compactProject(project),
    repository: { branch, groupPath },
    workItems: issuesPage.items.map(compactWorkItem),
    workItemsMayBeTruncated: issuesPage.pagination.hasNextPage &&
      !warnings.some((warning) => warning.startsWith("Could not read work items")),
    query: {
      state,
      issueLimit,
      issueFilters,
      includeEpics: options.includeEpics === true,
      staleDays,
    },
    mergeRequests: mergeRequestsPage.items.map(compactMergeRequest),
    pipelines: pipelinesPage.items.map(compactPipeline),
    planning: {
      labels: labelsPage.items.map(compactLabel),
      milestones: milestonesPage.items.map(compactMilestone),
      boards: boardsPage.boards,
      iterations: iterationsPage.items.map(compactIteration),
      epics: groupEpics.epics.map(compactEpic),
      epicsMayBeTruncated: groupEpics.mayBeTruncated,
    },
    pagination: {
      workItems: issuesPage.pagination,
      mergeRequests: mergeRequestsPage.pagination,
      pipelines: pipelinesPage.pagination,
      labels: labelsPage.pagination,
      milestones: milestonesPage.pagination,
      boards: boardsPage.pagination,
      boardLists: boardsPage.boardLists,
      iterations: iterationsPage.pagination,
      epics: paginationForCount(groupEpics.epics.length, 50, groupEpics.mayBeTruncated),
    },
    story,
    stats: {
      workItems: issuesPage.items.length,
      mergeRequests: mergeRequestsPage.items.length,
      pipelines: pipelinesPage.items.length,
      labels: labelsPage.items.length,
      milestones: milestonesPage.items.length,
      boards: boardsPage.boards.length,
      iterations: iterationsPage.items.length,
      epics: groupEpics.epics.length,
    },
    planningHealth: inspectPlanningHealth(issuesPage.items, boardsPage.boards, staleDays),
    warnings,
  };
  try {
    await writeSyncCache(root, {
      version: SYNC_CACHE_VERSION,
      savedAt: result.cache.savedAt,
      host: remote.host,
      projectPath: remote.projectPath,
      query: cacheQuery,
      result,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    result.warnings.push("Could not save local sync cache: " + message);
  }
  try {
    await saveSyncReadModel({
      root,
      host: remote.host,
      projectPath: remote.projectPath,
      result,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    result.warnings.push("Could not save local SQLite read model: " + message);
  }
  return result;
}

export function formatSyncMarkdown(result: SyncResult): string {
  const lines = [
    "# oflow sync",
    "",
    "Generated: " + result.generatedAt,
    "Source: " + (result.cache.source === "cache" ? "local cache" : "GitLab REST") +
      "; snapshot age " + formatAge(result.cache.ageSeconds),
    "Project: [" + result.project.path + "](" + result.project.webUrl + ")",
    "Branch: " + (result.repository.branch ?? "detached/unknown"),
    "Work-item query: " + result.query.state +
      "; limit " + String(result.query.issueLimit) +
      (formatIssueFilters(result.query.issueFilters) || "") +
      (result.query.staleDays === null ? "" : "; stale after " + String(result.query.staleDays) + " days"),
    "",
    "## Snapshot",
    "",
    "- Work items: " + String(result.stats.workItems) +
      paginationSuffix(result.pagination.workItems),
    "- Open merge requests: " + String(result.stats.mergeRequests) +
      paginationSuffix(result.pagination.mergeRequests),
    "- Pipelines: " + String(result.stats.pipelines) +
      paginationSuffix(result.pagination.pipelines),
    "- Labels: " + String(result.stats.labels) +
      paginationSuffix(result.pagination.labels),
    "- Active milestones: " + String(result.stats.milestones) +
      paginationSuffix(result.pagination.milestones),
    "- Boards: " + String(result.stats.boards) +
      paginationSuffix(result.pagination.boards),
    "- Project-visible iterations: " + String(result.stats.iterations) +
      paginationSuffix(result.pagination.iterations),
    ...(result.query.includeEpics
      ? ["- Group epics: " + String(result.stats.epics) +
        paginationSuffix(result.pagination.epics)]
      : []),
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
          (item.assignees.length > 0 ? " · assignee: " + item.assignees.join(", ") : "") +
          (item.parent ? " · parent: " + item.parent.title : "") +
          (item.milestone ? " · milestone: " + item.milestone : "") +
          (item.iteration ? " · iteration: " + item.iteration : "") +
          (item.taskCompletion
            ? " · tasks: " + String(item.taskCompletion.completed) + "/" + String(item.taskCompletion.total)
            : "") +
          (item.weight !== null ? " · weight: " + String(item.weight) : "") +
          (item.dueDate ? " · due: " + item.dueDate : ""),
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
  if (result.query.includeEpics) {
    lines.push(
      "Epics: " +
        (result.planning.epics.length > 0
          ? result.planning.epics
            .map((epic) => "&" + String(epic.iid) + " " + epic.title)
            .join(", ")
          : "none"),
    );
  }

  if (result.planningHealth.findings.length > 0) {
    lines.push(
      "",
      "## Planning health",
      "",
      ...result.planningHealth.findings.map(
        (finding) =>
          "- " +
          finding.message +
          (finding.storyIids.length > 0
            ? " (stories: " + finding.storyIids.map((iid) => "#" + iid).join(", ") + ")"
            : ""),
      ),
    );
  }

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
    "Use `oflow sync --summary --json` for the token-light agent handoff or `oflow context --story <iid>` for full story evidence.",
    "",
  );
  return lines.join("\n");
}

export function compactSyncSummary(result: SyncResult): SyncSummary {
  return {
    generatedAt: result.generatedAt,
    cache: result.cache,
    project: result.project,
    repository: result.repository,
    query: result.query,
    workItems: result.workItems.map((item) => ({
      iid: item.iid,
      title: item.title,
      state: item.state,
      labels: item.labels,
      milestone: item.milestone,
      iteration: item.iteration,
      assignees: item.assignees,
      taskCompletion: item.taskCompletion,
      updatedAt: item.updatedAt,
      webUrl: item.webUrl,
    })),
    workItemsMayBeTruncated: result.workItemsMayBeTruncated,
    mergeRequests: result.mergeRequests.map((mergeRequest) => ({
      iid: mergeRequest.iid,
      title: mergeRequest.title,
      state: mergeRequest.state,
      draft: mergeRequest.draft,
      sourceBranch: mergeRequest.sourceBranch,
      targetBranch: mergeRequest.targetBranch,
      webUrl: mergeRequest.webUrl,
    })),
    pipelines: result.pipelines.map((pipeline) => ({
      id: pipeline.id,
      status: pipeline.status,
      ref: pipeline.ref,
      sha: pipeline.sha,
      webUrl: pipeline.webUrl,
    })),
    planning: {
      labels: result.planning.labels.map((label) => label.name),
      milestones: result.planning.milestones.map(({ iid, title, state, startDate, dueDate }) => ({
        iid,
        title,
        state,
        startDate,
        dueDate,
      })),
      boards: result.planning.boards.map((board) => ({
        id: board.id,
        name: board.name,
        lists: board.lists
          .map((list) => list.label)
          .filter((label): label is string => label !== null),
      })),
      iterations: result.planning.iterations.map(({ iid, title, state, startDate, dueDate }) => ({
        iid,
        title,
        state,
        startDate,
        dueDate,
      })),
      epicCount: result.planning.epics.length,
      epicsMayBeTruncated: result.planning.epicsMayBeTruncated,
    },
    story: result.story === null
      ? null
      : {
          iid: result.story.iid,
          title: result.story.title,
          state: result.story.state,
          labels: result.story.labels,
          milestone: result.story.milestone,
          iteration: result.story.iteration,
          assignees: result.story.assignees,
          taskCompletion: result.story.taskCompletion,
          acceptanceCriteria: result.story.acceptanceCriteria.length,
          mergeRequests: result.story.mergeRequests.length,
          pipelines: result.story.pipelines.length,
          recentNotes: result.story.recentNotes,
          webUrl: result.story.webUrl,
        },
    stats: result.stats,
    planningHealth: result.planningHealth,
    warnings: result.warnings,
  };
}

export function formatSyncSummaryMarkdown(result: SyncSummary): string {
  const lines = [
    "# oflow sync summary",
    "",
    "Generated: " + result.generatedAt,
    "Source: " + (result.cache.source === "cache" ? "local cache" : "GitLab REST") +
      "; snapshot age " + formatAge(result.cache.ageSeconds),
    "Project: [" + result.project.path + "](" + result.project.webUrl + ")",
    "Branch: " + (result.repository.branch ?? "detached/unknown"),
    "Work-item query: " + result.query.state + "; limit " + String(result.query.issueLimit),
    "",
    "## Counts",
    "",
    "- Work items: " + String(result.stats.workItems) +
      (result.workItemsMayBeTruncated ? " (more available)" : ""),
    "- Open merge requests: " + String(result.stats.mergeRequests),
    "- Pipelines: " + String(result.stats.pipelines),
    "- Labels: " + String(result.stats.labels),
    "- Active milestones: " + String(result.stats.milestones),
    "- Boards: " + String(result.stats.boards),
    "- Project-visible iterations: " + String(result.stats.iterations),
    ...(result.query.includeEpics
      ? ["- Group epics: " + String(result.planning.epicCount) +
        (result.planning.epicsMayBeTruncated ? " (more available)" : "")]
      : []),
    "",
    "## Work items",
    "",
  ];
  if (result.workItems.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push(...result.workItems.map((item) =>
      "- #" + String(item.iid) + " " + linkOrText(item.title, item.webUrl) +
      (item.milestone ? " · milestone: " + item.milestone : "") +
      (item.iteration ? " · iteration: " + item.iteration : "") +
      (item.assignees.length > 0 ? " · assignee: " + item.assignees.join(", ") : "") +
      (item.taskCompletion
        ? " · tasks: " + String(item.taskCompletion.completed) + "/" + String(item.taskCompletion.total)
        : ""),
    ));
  }
  if (result.story !== null) {
    lines.push(
      "",
      "## Focused story",
      "",
      "- #" + String(result.story.iid) + " " + linkOrText(result.story.title, result.story.webUrl) +
        " · acceptance criteria: " + String(result.story.acceptanceCriteria) +
        " · merge requests: " + String(result.story.mergeRequests) +
        " · notes: " + String(result.story.recentNotes),
    );
  }
  if (result.planningHealth.findings.length > 0) {
    lines.push(
      "",
      "## Planning health",
      "",
      ...result.planningHealth.findings.map((finding) =>
        "- " + finding.message +
        (finding.storyIids.length > 0
          ? " (stories: " + finding.storyIids.map((iid) => "#" + iid).join(", ") + ")"
          : "")),
    );
  }
  if (result.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...result.warnings.map((warning) => "- " + warning));
  }
  lines.push("", "Use `oflow assess --story <iid>` for detailed acceptance and delivery evidence.", "");
  return lines.join("\n");
}

async function loadStorySummary(
  client: GitLabClient,
  projectPath: string,
  storyIid: number,
  branch: string | null,
  warnings: string[],
  knownPipelines?: GitLabPipeline[],
): Promise<SyncStory> {
  const pipelineReadFailed = warnings.some((warning) =>
    warning.startsWith("Could not read pipelines"),
  );
  const storyPipelines = knownPipelines !== undefined && !pipelineReadFailed
    ? Promise.resolve(knownPipelines)
    : optionalFetch(
        () => client.listPipelines(projectPath, branch, 10),
        "Could not read story pipelines",
        warnings,
      );
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
    storyPipelines,
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
    assignees: usernames(issue.assignees),
    startDate: issue.start_date ?? null,
    dueDate: issue.due_date ?? null,
    weight: issue.weight ?? null,
    taskCompletion: compactTaskCompletion(issue.task_completion_status),
    parent: compactParent(issue.parent ?? issue.epic),
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
): Promise<LoadedBoards> {
  const boardPage = await client.listBoardsPage(projectPath, 100);
  const loaded = await Promise.all(
    boardPage.items.map(async (board) => {
      const listPage = await client.listBoardListsPage(projectPath, board.id, 100);
      return {
        board: {
          id: board.id,
          name: oneLine(board.name),
          lists: listPage.items.map((list) => ({
            id: list.id,
            label: list.label?.name ?? null,
            position: list.position ?? null,
          })),
        },
        boardLists: { boardId: board.id, pagination: listPage.pagination },
      };
    }),
  );
  return {
    boards: loaded.map((item) => item.board),
    pagination: boardPage.pagination,
    boardLists: loaded.map((item) => item.boardLists),
  };
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
    assignees: usernames(issue.assignees),
    startDate: issue.start_date ?? null,
    dueDate: issue.due_date ?? null,
    weight: issue.weight ?? null,
    taskCompletion: compactTaskCompletion(issue.task_completion_status),
    parent: compactParent(issue.parent ?? issue.epic),
    updatedAt: issue.updated_at ?? null,
    webUrl: issue.web_url ?? null,
  };
}

function compactTaskCompletion(value: unknown): SyncWorkItem["taskCompletion"] {
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

function usernames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const username = record.username ?? record.name;
      return typeof username === "string" && username.trim() ? username : null;
    })
    .filter((username): username is string => username !== null);
}

function inspectPlanningHealth(
  issues: GitLabIssue[],
  boards: SyncBoard[],
  staleDays: number | null,
): SyncPlanningHealth {
  const findings: SyncPlanningHealth["findings"] = [];
  const describedIssues = issues.filter((issue) => typeof issue.description === "string");
  const missingCriteria = describedIssues.filter(
    (issue) => parseAcceptanceCriteria(issue.description ?? "").length === 0,
  );
  if (missingCriteria.length > 0) {
    findings.push({
      code: "missing-acceptance-criteria",
      message: `${missingCriteria.length} work item${missingCriteria.length === 1 ? " has" : "s have"} no acceptance-criteria checklist`,
      storyIids: missingCriteria.slice(0, 10).map((issue) => issue.iid),
    });
  }

  const assigneesKnown = issues.length > 0 && issues.every((issue) => Array.isArray(issue.assignees));
  const unassigned = assigneesKnown
    ? issues.filter((issue) => (issue.assignees ?? []).length === 0)
    : [];
  if (unassigned.length > 0) {
    findings.push({
      code: "unassigned-work-item",
      message: `${unassigned.length} open work item${unassigned.length === 1 ? " has" : "s have"} no assignee`,
      storyIids: unassigned.slice(0, 10).map((issue) => issue.iid),
    });
  }

  const timeboxKnown =
    issues.length > 0 &&
    issues.every((issue) => Object.prototype.hasOwnProperty.call(issue, "milestone") ||
      Object.prototype.hasOwnProperty.call(issue, "iteration"));
  const untimeboxed = timeboxKnown
    ? issues.filter((issue) => !namedValue(issue.milestone) && !namedValue(issue.iteration))
    : [];
  if (untimeboxed.length > 0) {
    findings.push({
      code: "untimeboxed-work-item",
      message: `${untimeboxed.length} open work item${untimeboxed.length === 1 ? " has" : "s have"} no milestone or iteration`,
      storyIids: untimeboxed.slice(0, 10).map((issue) => issue.iid),
    });
  }

  if (staleDays !== null) {
    const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
    const stale = issues.filter((issue) => {
      if (typeof issue.updated_at !== "string") {
        return false;
      }
      const updatedAt = Date.parse(issue.updated_at);
      return Number.isFinite(updatedAt) && updatedAt < cutoff;
    });
    if (stale.length > 0) {
      findings.push({
        code: "stale-work-item",
        message: `${stale.length} work item${stale.length === 1 ? " has" : "s have"} not changed in the last ${staleDays} day${staleDays === 1 ? "" : "s"}`,
        storyIids: stale.slice(0, 10).map((issue) => issue.iid),
      });
    }
  }

  for (const board of boards) {
    const boardLabels = [...new Set(
      board.lists
        .map((list) => list.label)
        .filter((label): label is string => label !== null && label.trim().length > 0),
    )];
    if (boardLabels.length < 2) {
      continue;
    }
    const conflicts = issues.filter((issue) => {
      const workflowLabels = (issue.labels ?? []).filter((label) => boardLabels.includes(label));
      return new Set(workflowLabels).size > 1;
    });
    if (conflicts.length > 0) {
      findings.push({
        code: "conflicting-board-labels",
        message: `${conflicts.length} work item${conflicts.length === 1 ? " has" : "s have"} multiple workflow labels on board ${board.name}`,
        storyIids: conflicts.slice(0, 10).map((issue) => issue.iid),
      });
    }
  }

  return { findings };
}

function validateStaleDays(value: number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > 3650) {
    throw new OflowError(
      "Stale days must be an integer between 1 and 3650.",
      "INVALID_STALE_DAYS",
    );
  }
  return value;
}

function validateCacheMode(value: SyncCacheMode | undefined): SyncCacheMode {
  if (value === undefined || value === "refresh") {
    return "refresh";
  }
  if (value === "cached") {
    return value;
  }
  throw new OflowError(
    "Sync cache mode must be refresh or cached.",
    "INVALID_SYNC_CACHE_MODE",
  );
}

function createCacheQuery(query: SyncCacheQuery): SyncCacheQuery {
  return {
    ...query,
    issueFilters: Object.fromEntries(
      Object.entries(query.issueFilters).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

async function loadCachedSync(
  root: string,
  host: string,
  projectPath: string,
  branch: string | null,
  query: SyncCacheQuery,
  warnings: string[],
): Promise<SyncResult> {
  let envelope: SyncCacheEnvelope<SyncCacheQuery> | null;
  try {
    envelope = await readSyncCache<SyncCacheQuery>(root);
  } catch (error: unknown) {
    if (error instanceof OflowError && error.code === "INVALID_JSON") {
      throw new OflowError(
        "The local sync snapshot at " + SYNC_CACHE_RELATIVE_PATH + " is invalid. Run oflow sync --refresh to replace it.",
        "SYNC_CACHE_INVALID",
      );
    }
    throw error;
  }
  if (envelope === null) {
    throw new OflowError(
      "No local sync snapshot exists at " + SYNC_CACHE_RELATIVE_PATH + ". Run oflow sync --refresh first.",
      "SYNC_CACHE_MISS",
    );
  }
  if (!isSyncCacheEnvelope(envelope)) {
    throw new OflowError(
      "The local sync snapshot at " + SYNC_CACHE_RELATIVE_PATH + " is invalid. Run oflow sync --refresh to replace it.",
      "SYNC_CACHE_INVALID",
    );
  }
  if (envelope.host !== host || envelope.projectPath !== projectPath) {
    throw new OflowError(
      "The local sync snapshot targets a different GitLab project. Run oflow sync --refresh.",
      "SYNC_CACHE_TARGET_MISMATCH",
    );
  }
  if (JSON.stringify(envelope.query) !== JSON.stringify(query)) {
    throw new OflowError(
      "The local sync snapshot was created with different filters. Run oflow sync --refresh with the requested filters.",
      "SYNC_CACHE_QUERY_MISMATCH",
    );
  }

  const result = envelope.result;
  const currentBranch = result.repository.branch;
  if (currentBranch !== branch) {
    warnings.push(
      "Cached snapshot was created on branch " +
        (currentBranch ?? "detached/unknown") +
        "; current branch is " +
        (branch ?? "detached/unknown") + ".",
    );
  }
  return {
    ...result,
    cache: {
      source: "cache",
      savedAt: envelope.savedAt,
      ageSeconds: cacheAgeSeconds(envelope.savedAt),
    },
    warnings: [...result.warnings, ...warnings],
  };
}

function isSyncCacheEnvelope(
  value: SyncCacheEnvelope<SyncCacheQuery>,
): value is SyncCacheEnvelope<SyncCacheQuery> & { result: SyncResult } {
  if (
    value.version !== SYNC_CACHE_VERSION ||
    typeof value.savedAt !== "string" ||
    !Number.isFinite(Date.parse(value.savedAt)) ||
    typeof value.host !== "string" ||
    typeof value.projectPath !== "string" ||
    !value.query ||
    typeof value.query !== "object" ||
    !value.result ||
    typeof value.result !== "object"
  ) {
    return false;
  }
  const result = value.result as Partial<SyncResult>;
  return Boolean(
    typeof result.generatedAt === "string" &&
      result.project &&
      result.repository &&
      Array.isArray(result.workItems) &&
      Array.isArray(result.mergeRequests) &&
      Array.isArray(result.pipelines) &&
      result.planning &&
      Array.isArray(result.warnings),
  );
}

function cacheAgeSeconds(savedAt: string): number {
  const timestamp = Date.parse(savedAt);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
}

function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) {
    return "less than 1 minute";
  }
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) {
    return minutes + " minute" + (minutes === 1 ? "" : "s");
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return hours + " hour" + (hours === 1 ? "" : "s");
  }
  const days = Math.floor(hours / 24);
  return days + " day" + (days === 1 ? "" : "s");
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

function compactEpic(epic: GitLabGroupEpic): SyncEpic {
  return {
    iid: epic.iid,
    title: oneLine(epic.title),
    state: epic.state,
    webUrl: epic.web_url,
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

function emptyListPage<T>(requested: number): GitLabListPage<T> {
  return {
    items: [],
    pagination: emptyPagination(requested),
  };
}

function emptyPagination(requested: number): GitLabPagination {
  return paginationForCount(0, requested, false);
}

function paginationForCount(
  returned: number,
  requested: number,
  hasNextPage: boolean,
): GitLabPagination {
  return {
    returned,
    requested,
    page: 1,
    nextPage: hasNextPage ? 2 : null,
    total: null,
    totalPages: null,
    hasNextPage,
  };
}

function paginationSuffix(pagination: GitLabPagination): string {
  return pagination.hasNextPage ? " (more may exist)" : "";
}

function parentGroupPath(projectPath: string): string | null {
  const separator = projectPath.lastIndexOf("/");
  return separator > 0 ? projectPath.slice(0, separator) : null;
}

function projectNamespacePath(project: GitLabProject): string | null {
  const fullPath = project.namespace?.full_path;
  return typeof fullPath === "string" && fullPath.trim() ? fullPath : null;
}

function namedValue(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = record.name ?? record.title;
  return typeof name === "string" && name.trim() ? oneLine(name) : null;
}

function compactParent(value: unknown): SyncParent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const title = record.title ?? record.name;
  if (typeof title !== "string" || !title.trim()) {
    return null;
  }
  const iid = typeof record.iid === "number"
    ? record.iid
    : typeof record.parent_iid === "number"
      ? record.parent_iid
      : null;
  return {
    title: oneLine(title),
    iid,
    webUrl: typeof record.web_url === "string" ? record.web_url : null,
  };
}

function formatIssueFilters(filters: GitLabIssueFilters): string {
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => key + "=" + JSON.stringify(value));
  return entries.length > 0 ? "; filters: " + entries.join(", ") : "";
}

function linkOrText(value: string, url: string | null): string {
  return url ? "[" + value + "](" + url + ")" : value;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
