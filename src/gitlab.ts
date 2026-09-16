import { OflowError } from "./errors.js";
import { getGitLabToken, redactGitLabToken } from "./auth.js";
import type {
  GitLabIssue,
  GitLabIssueCreate,
  GitLabIssueFilters,
  GitLabIssueUpdate,
  GitLabUser,
  GitLabBoard,
  GitLabBoardList,
  GitLabBoardCreate,
  GitLabBoardUpdate,
  GitLabBoardListCreate,
  GitLabBoardListUpdate,
  GitLabIteration,
  GitLabIterationCadence,
  GitLabGroupEpic,
  GitLabGroupEpicDetail,
  GitLabWorkItemReference,
  GitLabLabel,
  GitLabLabelCreate,
  GitLabLabelUpdate,
  GitLabMergeRequest,
  GitLabMilestone,
  GitLabMilestoneCreate,
  GitLabMilestoneUpdate,
  GitLabNoteCreate,
  GitLabNote,
  GitLabPipeline,
  GitLabProject,
  IssueState,
  IterationState,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

export interface GitLabPagination {
  returned: number;
  requested: number;
  page: number | null;
  nextPage: number | null;
  total: number | null;
  totalPages: number | null;
  hasNextPage: boolean;
}

export interface GitLabListPage<T> {
  items: T[];
  pagination: GitLabPagination;
}

export class GitLabApiError extends OflowError {
  readonly status: number;
  readonly retryAfter: number | null;

  constructor(
    message: string,
    status: number,
    retryAfter: number | null = null,
  ) {
    super(message, "GITLAB_API_ERROR");
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export { getGitLabToken } from "./auth.js";

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly graphqlUrl: string;
  private readonly token: string;

  constructor(host: string, token = getGitLabToken(host)) {
    if (!token) {
      throw new OflowError(
        "No GitLab token found. Run oflow auth login or set GITLAB_TOKEN for API-backed commands.",
        "MISSING_GITLAB_TOKEN",
      );
    }
    const normalizedHost = host.replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.baseUrl = "https://" + normalizedHost + "/api/v4";
    this.graphqlUrl = "https://" + normalizedHost + "/api/graphql";
    this.token = token;
  }

  async getProject(projectPath: string): Promise<GitLabProject> {
    const project = await this.request<unknown>(
      "/projects/" + encodeURIComponent(projectPath),
    );
    if (
      !isRecord(project) ||
      typeof project.id !== "number" ||
      typeof project.path_with_namespace !== "string"
    ) {
      throw new OflowError(
        "GitLab API returned an invalid project response.",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    return project as GitLabProject;
  }

  async getIssue(projectPath: string, iid: number): Promise<GitLabIssue> {
    return this.request<GitLabIssue>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/issues/" +
        String(iid),
    );
  }

  async getMergeRequest(projectPath: string, iid: number): Promise<GitLabMergeRequest> {
    return this.request<GitLabMergeRequest>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/merge_requests/" +
        String(iid),
    );
  }

  async listGroupEpics(
    groupPath: string,
    limit = 50,
  ): Promise<{ epics: GitLabGroupEpic[]; mayBeTruncated: boolean }> {
    const data = await this.requestGraphQL(
      `query GroupEpics($fullPath: ID!, $first: Int!) {
        group(fullPath: $fullPath) {
          workItems(types: [EPIC], first: $first) {
            nodes { id iid title state webUrl }
            pageInfo { hasNextPage }
          }
        }
      }`,
      { fullPath: groupPath, first: limit },
    );
    if (!isRecord(data) || data.group === null) {
      throw new OflowError(
        "GitLab GraphQL could not access group " + groupPath + ". Check Group: Read and Work Item: Read access, and confirm the instance supports group work items.",
        "GITLAB_GROUP_UNAVAILABLE",
      );
    }
    if (!isRecord(data.group) || !isRecord(data.group.workItems)) {
      throw new OflowError(
        "GitLab GraphQL returned no group work-item collection for " + groupPath + ".",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    const collection = data.group.workItems;
    if (!Array.isArray(collection.nodes) || !isRecord(collection.pageInfo) ||
      typeof collection.pageInfo.hasNextPage !== "boolean") {
      throw new OflowError(
        "GitLab GraphQL returned an invalid group epic list response.",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    return {
      epics: collection.nodes.map(parseGroupEpic),
      mayBeTruncated: collection.pageInfo.hasNextPage,
    };
  }

  async getGroupEpic(
    groupPath: string,
    iid: number,
  ): Promise<GitLabGroupEpicDetail> {
    const data = await this.requestGraphQL(
      `query GroupEpic($fullPath: ID!, $iid: String!) {
        namespace(fullPath: $fullPath) {
          workItem(iid: $iid) {
            id iid title state webUrl
            widgets {
              ... on WorkItemWidgetHierarchy {
                __typename
                parent { id iid title webUrl workItemType { name } }
                children { nodes { id iid title webUrl workItemType { name } } }
              }
            }
          }
        }
      }`,
      { fullPath: groupPath, iid: String(iid) },
    );
    if (!isRecord(data) || data.namespace === null) {
      throw new OflowError(
        "GitLab GraphQL could not access group " + groupPath + ". Check Group: Read and Work Item: Read access, and confirm the instance supports group work items.",
        "GITLAB_GROUP_UNAVAILABLE",
      );
    }
    if (!isRecord(data.namespace) || data.namespace.workItem === null) {
      throw new OflowError(
        "GitLab GraphQL could not find epic #" + String(iid) + " in group " + groupPath + ".",
        "GITLAB_EPIC_NOT_FOUND",
      );
    }
    const item = data.namespace.workItem;
    if (!isRecord(item)) {
      throw new OflowError(
        "GitLab GraphQL returned an invalid group epic response.",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    const epic = parseGroupEpic(item);
    const hierarchy = Array.isArray(item.widgets)
      ? item.widgets.find((widget) => isRecord(widget) && widget.__typename === "WorkItemWidgetHierarchy")
      : undefined;
    if (!isRecord(hierarchy)) {
      return { ...epic, parent: null, children: [] };
    }
    return {
      ...epic,
      parent: hierarchy.parent === null || hierarchy.parent === undefined
        ? null
        : parseWorkItemReference(hierarchy.parent),
      children: !isRecord(hierarchy.children) || !Array.isArray(hierarchy.children.nodes)
        ? []
        : hierarchy.children.nodes.map(parseWorkItemReference),
    };
  }

  async listIterationCadences(
    groupPath: string,
    limit = 20,
  ): Promise<{ cadences: GitLabIterationCadence[]; mayBeTruncated: boolean }> {
    const data = await this.requestGraphQL(
      `query GroupIterationCadences($fullPath: ID!, $first: Int!) {
        group(fullPath: $fullPath) {
          iterationCadences(includeAncestorGroups: true, first: $first) {
            nodes {
              id title active automatic durationInWeeks iterationsInAdvance rollOver startDate
            }
            pageInfo { hasNextPage }
          }
        }
      }`,
      { fullPath: groupPath, first: limit },
    );
    if (!isRecord(data) || data.group === null) {
      throw new OflowError(
        "GitLab GraphQL could not access group " + groupPath + ". Check Group: Read and iteration access.",
        "GITLAB_GROUP_UNAVAILABLE",
      );
    }
    if (!isRecord(data.group) || !isRecord(data.group.iterationCadences)) {
      throw new OflowError(
        "GitLab GraphQL returned no iteration-cadence collection for " + groupPath + ".",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    const collection = data.group.iterationCadences;
    if (!Array.isArray(collection.nodes) || !isRecord(collection.pageInfo) ||
      typeof collection.pageInfo.hasNextPage !== "boolean") {
      throw new OflowError(
        "GitLab GraphQL returned an invalid iteration-cadence list response.",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    return {
      cadences: collection.nodes.map(parseIterationCadence),
      mayBeTruncated: collection.pageInfo.hasNextPage,
    };
  }

  async listIssuesPage(
    projectPath: string,
    state: IssueState = "opened",
    limit = 100,
    filters: GitLabIssueFilters = {},
  ): Promise<GitLabListPage<GitLabIssue>> {
    const query = new URLSearchParams({
      state,
      per_page: String(limit),
      order_by: "updated_at",
      sort: "desc",
      scope: "all",
    });
    if (filters.label !== undefined) {
      query.set("labels", filters.label);
    }
    if (filters.milestone !== undefined) {
      query.set("milestone", filters.milestone);
    }
    if (filters.iteration !== undefined) {
      const iteration = filters.iteration.trim();
      const normalized = iteration.toLowerCase();
      if (normalized === "none" || normalized === "any") {
        query.set("iteration_id", normalized === "none" ? "None" : "Any");
      } else {
        query.set("iteration_title", iteration);
      }
    }
    if (filters.epic !== undefined) {
      const epic = filters.epic.trim();
      const normalized = epic.toLowerCase();
      if (["none", "null", "unassigned"].includes(normalized)) {
        query.set("epic_id", "None");
      } else if (normalized === "any") {
        query.set("epic_id", "Any");
      } else {
        query.set("epic_id", epic);
      }
    }
    if (filters.search !== undefined) {
      query.set("search", filters.search);
    }
    if (filters.updatedAfter !== undefined) {
      query.set("updated_after", filters.updatedAfter);
    }
    if (filters.updatedBefore !== undefined) {
      query.set("updated_before", filters.updatedBefore);
    }
    if (filters.assignee !== undefined) {
      const assignee = filters.assignee.trim();
      if (["none", "null", "unassigned"].includes(assignee.toLowerCase())) {
        query.set("assignee_id", "None");
      } else if (assignee.toLowerCase() === "any") {
        query.set("assignee_id", "Any");
      } else {
        for (const username of assignee.split(",").map((item) => item.trim()).filter(Boolean)) {
          query.append("assignee_username[]", username);
        }
      }
    }
    if (filters.author !== undefined) {
      query.set("author_username", filters.author.trim());
    }
    const response = await this.requestWithMetadata<unknown>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/issues?" + query.toString(),
    );
    if (!Array.isArray(response.body)) {
      throw new OflowError(
        "GitLab API returned an invalid issue list response.",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    return {
      items: response.body as GitLabIssue[],
      pagination: parsePagination(response.headers, limit, response.body.length),
    };
  }

  async listIssues(
    projectPath: string,
    state: IssueState = "opened",
    limit = 100,
    filters: GitLabIssueFilters = {},
  ): Promise<GitLabIssue[]> {
    return (await this.listIssuesPage(projectPath, state, limit, filters)).items;
  }

  async updateIssue(
    projectPath: string,
    iid: number,
    changes: GitLabIssueUpdate,
  ): Promise<GitLabIssue> {
    return this.request<GitLabIssue>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/issues/" +
        String(iid),
      {
        method: "PUT",
        form: changes as unknown as Record<
          string,
          string | number | boolean | Array<string | number | boolean> | undefined
        >,
      },
    );
  }

  async createIssue(
    projectPath: string,
    issue: GitLabIssueCreate,
  ): Promise<GitLabIssue> {
    return this.request<GitLabIssue>(
      "/projects/" + encodeURIComponent(projectPath) + "/issues",
      {
        method: "POST",
        form: issue as unknown as Record<
          string,
          string | number | boolean | Array<string | number | boolean> | undefined
        >,
        retryable: false,
      },
    );
  }

  async listUsersByUsername(username: string): Promise<GitLabUser[]> {
    const result = await this.request<unknown>(
      "/users?username=" + encodeURIComponent(username),
    );
    if (!Array.isArray(result)) {
      throw new OflowError(
        "GitLab API returned an invalid user search response.",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    return result as GitLabUser[];
  }

  async listLabelsPage(projectPath: string, limit = 100): Promise<GitLabListPage<GitLabLabel>> {
    return this.listResponsePage<GitLabLabel>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/labels?per_page=" +
        String(limit) +
        "&with_counts=true",
      "label list",
      limit,
    );
  }

  async listLabels(projectPath: string, limit = 100): Promise<GitLabLabel[]> {
    return (await this.listLabelsPage(projectPath, limit)).items;
  }

  async createLabel(
    projectPath: string,
    label: GitLabLabelCreate,
  ): Promise<GitLabLabel> {
    return this.request<GitLabLabel>(
      "/projects/" + encodeURIComponent(projectPath) + "/labels",
      {
        method: "POST",
        form: {
          name: label.name,
          color: label.color,
          description: label.description,
        },
        retryable: false,
      },
    );
  }

  async updateLabel(
    projectPath: string,
    label: string | number,
    changes: GitLabLabelUpdate,
  ): Promise<GitLabLabel> {
    return this.request<GitLabLabel>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/labels/" +
        encodeURIComponent(String(label)),
      {
        method: "PUT",
        form: {
          new_name: changes.new_name,
          color: changes.color,
          description: changes.description,
        },
      },
    );
  }

  async listMilestonesPage(
    projectPath: string,
    state: "active" | "closed" | "all" = "active",
    limit = 100,
  ): Promise<GitLabListPage<GitLabMilestone>> {
    const stateQuery = state === "all" ? "" : "&state=" + state;
    return this.listResponsePage<GitLabMilestone>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/milestones?per_page=" +
        String(limit) +
        stateQuery +
        "&include_ancestors=true",
      "milestone list",
      limit,
    );
  }

  async listMilestones(
    projectPath: string,
    state: "active" | "closed" | "all" = "active",
    limit = 100,
  ): Promise<GitLabMilestone[]> {
    return (await this.listMilestonesPage(projectPath, state, limit)).items;
  }

  async getMilestone(projectPath: string, iid: number): Promise<GitLabMilestone> {
    return this.request<GitLabMilestone>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/milestones/" +
        String(iid),
    );
  }

  async createMilestone(
    projectPath: string,
    milestone: GitLabMilestoneCreate,
  ): Promise<GitLabMilestone> {
    return this.request<GitLabMilestone>(
      "/projects/" + encodeURIComponent(projectPath) + "/milestones",
      {
        method: "POST",
        form: {
          title: milestone.title,
          description: milestone.description,
          start_date: milestone.start_date,
          due_date: milestone.due_date,
        },
        retryable: false,
      },
    );
  }

  async updateMilestone(
    projectPath: string,
    iid: number,
    changes: GitLabMilestoneUpdate,
  ): Promise<GitLabMilestone> {
    return this.request<GitLabMilestone>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/milestones/" +
        String(iid),
      {
        method: "PUT",
        form: {
          title: changes.title,
          description: changes.description,
          start_date: changes.start_date,
          due_date: changes.due_date,
          state_event: changes.state_event,
        },
      },
    );
  }

  async listBoardsPage(projectPath: string, limit = 100): Promise<GitLabListPage<GitLabBoard>> {
    return this.listResponsePage<GitLabBoard>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/boards?per_page=" +
        String(limit),
      "board list",
      limit,
    );
  }

  async listBoards(projectPath: string, limit = 100): Promise<GitLabBoard[]> {
    return (await this.listBoardsPage(projectPath, limit)).items;
  }

  async getBoard(projectPath: string, boardId: number): Promise<GitLabBoard> {
    return this.request<GitLabBoard>(
      "/projects/" + encodeURIComponent(projectPath) + "/boards/" + String(boardId),
    );
  }

  async createBoard(projectPath: string, board: GitLabBoardCreate): Promise<GitLabBoard> {
    return this.request<GitLabBoard>(
      "/projects/" + encodeURIComponent(projectPath) + "/boards",
      { method: "POST", form: { ...board }, retryable: false },
    );
  }

  async updateBoard(
    projectPath: string,
    boardId: number,
    changes: GitLabBoardUpdate,
  ): Promise<GitLabBoard> {
    return this.request<GitLabBoard>(
      "/projects/" + encodeURIComponent(projectPath) + "/boards/" + String(boardId),
      { method: "PUT", form: { ...changes } },
    );
  }

  async listBoardListsPage(
    projectPath: string,
    boardId: number,
    limit = 100,
  ): Promise<GitLabListPage<GitLabBoardList>> {
    return this.listResponsePage<GitLabBoardList>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/boards/" +
        String(boardId) +
        "/lists?per_page=" +
        String(limit),
      "board list entries",
      limit,
    );
  }

  async listBoardLists(
    projectPath: string,
    boardId: number,
    limit = 100,
  ): Promise<GitLabBoardList[]> {
    return (await this.listBoardListsPage(projectPath, boardId, limit)).items;
  }

  async getBoardList(
    projectPath: string,
    boardId: number,
    listId: number,
  ): Promise<GitLabBoardList> {
    return this.request<GitLabBoardList>(
      "/projects/" + encodeURIComponent(projectPath) + "/boards/" +
        String(boardId) + "/lists/" + String(listId),
    );
  }

  async createBoardList(
    projectPath: string,
    boardId: number,
    list: GitLabBoardListCreate,
  ): Promise<GitLabBoardList> {
    return this.request<GitLabBoardList>(
      "/projects/" + encodeURIComponent(projectPath) + "/boards/" +
        String(boardId) + "/lists",
      { method: "POST", form: { ...list }, retryable: false },
    );
  }

  async updateBoardList(
    projectPath: string,
    boardId: number,
    listId: number,
    changes: GitLabBoardListUpdate,
  ): Promise<GitLabBoardList> {
    return this.request<GitLabBoardList>(
      "/projects/" + encodeURIComponent(projectPath) + "/boards/" +
        String(boardId) + "/lists/" + String(listId),
      { method: "PUT", form: { ...changes } },
    );
  }

  async listGroupIterationsPage(
    groupPath: string,
    state: IterationState = "all",
    limit = 100,
  ): Promise<GitLabListPage<GitLabIteration>> {
    const stateQuery = state === "all" ? "" : "&state=" + state;
    return this.listResponsePage<GitLabIteration>(
      "/groups/" +
        encodeURIComponent(groupPath) +
        "/iterations?per_page=" +
        String(limit) +
        stateQuery +
        "&include_ancestors=true",
      "iteration list",
      limit,
    );
  }

  async listGroupIterations(
    groupPath: string,
    state: IterationState = "all",
    limit = 100,
  ): Promise<GitLabIteration[]> {
    return (await this.listGroupIterationsPage(groupPath, state, limit)).items;
  }

  async listProjectIterationsPage(
    projectPath: string,
    state: IterationState = "all",
    limit = 100,
  ): Promise<GitLabListPage<GitLabIteration>> {
    const stateQuery = state === "all" ? "" : "&state=" + state;
    return this.listResponsePage<GitLabIteration>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/iterations?per_page=" +
        String(limit) +
        stateQuery +
        "&include_ancestors=true",
      "project iteration list",
      limit,
    );
  }

  async listProjectIterations(
    projectPath: string,
    state: IterationState = "all",
    limit = 100,
  ): Promise<GitLabIteration[]> {
    return (await this.listProjectIterationsPage(projectPath, state, limit)).items;
  }

  async getIssueNotes(projectPath: string, iid: number): Promise<GitLabNote[]> {
    return this.request<GitLabNote[]>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/issues/" +
        String(iid) +
        "/notes?per_page=100&sort=desc&order_by=created_at",
    );
  }

  async createIssueNote(
    projectPath: string,
    iid: number,
    note: GitLabNoteCreate,
  ): Promise<GitLabNote> {
    return this.request<GitLabNote>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/issues/" +
        String(iid) +
        "/notes",
      { method: "POST", form: { body: note.body }, retryable: false },
    );
  }

  async listMergeRequestsPage(
    projectPath: string,
    storyIid?: number,
    state: IssueState = storyIid ? "all" : "opened",
    limit = 20,
  ): Promise<GitLabListPage<GitLabMergeRequest>> {
    const result = await this.listResponsePage<GitLabMergeRequest>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/merge_requests?state=" +
        encodeURIComponent(state) +
        "&per_page=" +
        String(limit) +
        (storyIid ? "&search=" + encodeURIComponent("#" + storyIid) : ""),
      "merge request list",
      limit,
    );
    if (!storyIid) {
      return result;
    }
    return {
      ...result,
      items: result.items.filter((mergeRequest) => {
      const text =
        String(mergeRequest.title ?? "") +
        "\n" +
        String(mergeRequest.description ?? "") +
        "\n" +
        String(mergeRequest.source_branch ?? "");
      return new RegExp("#" + storyIid + "\\b").test(text) ||
        new RegExp("\\b(?:story|feature|fix|chore)[^\\n]*" + storyIid + "\\b", "i").test(text);
      }),
    };
  }

  async listMergeRequests(
    projectPath: string,
    storyIid?: number,
    state: IssueState = storyIid ? "all" : "opened",
    limit = 20,
  ): Promise<GitLabMergeRequest[]> {
    return (await this.listMergeRequestsPage(projectPath, storyIid, state, limit)).items;
  }

  async listRelatedMergeRequestsPage(
    projectPath: string,
    issueIid: number,
    limit = 20,
  ): Promise<GitLabListPage<GitLabMergeRequest>> {
    return this.listResponsePage<GitLabMergeRequest>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/issues/" +
        String(issueIid) +
        "/related_merge_requests?per_page=" +
        String(limit),
      "related merge request list",
      limit,
    );
  }

  async listRelatedMergeRequests(
    projectPath: string,
    issueIid: number,
    limit = 20,
  ): Promise<GitLabMergeRequest[]> {
    return (await this.listRelatedMergeRequestsPage(projectPath, issueIid, limit)).items;
  }

  async listMergeRequestPipelinesPage(
    projectPath: string,
    mergeRequestIid: number,
    limit = 20,
  ): Promise<GitLabListPage<GitLabPipeline>> {
    return this.listResponsePage<GitLabPipeline>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/merge_requests/" +
        String(mergeRequestIid) +
        "/pipelines?per_page=" +
        String(limit),
      "merge request pipeline list",
      limit,
    );
  }

  async listMergeRequestPipelines(
    projectPath: string,
    mergeRequestIid: number,
    limit = 20,
  ): Promise<GitLabPipeline[]> {
    return (await this.listMergeRequestPipelinesPage(projectPath, mergeRequestIid, limit)).items;
  }

  async listPipelinesPage(
    projectPath: string,
    ref?: string | null,
    limit = 20,
  ): Promise<GitLabListPage<GitLabPipeline>> {
    const query = ref ? "&ref=" + encodeURIComponent(ref) : "";
    return this.listResponsePage<GitLabPipeline>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/pipelines?per_page=" + String(limit) + "&order_by=id&sort=desc" +
        query,
      "pipeline list",
      limit,
    );
  }

  async listPipelines(
    projectPath: string,
    ref?: string | null,
    limit = 20,
  ): Promise<GitLabPipeline[]> {
    return (await this.listPipelinesPage(projectPath, ref, limit)).items;
  }

  private async listResponsePage<T>(
    path: string,
    label: string,
    requested: number,
  ): Promise<GitLabListPage<T>> {
    const response = await this.requestWithMetadata<unknown>(path);
    if (!Array.isArray(response.body)) {
      throw new OflowError(
        "GitLab API returned an invalid " + label + " response.",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    return {
      items: response.body as T[],
      pagination: parsePagination(response.headers, requested, response.body.length),
    };
  }

  private async listResponse<T>(path: string, label: string, requested = 100): Promise<T[]> {
    return (await this.listResponsePage<T>(path, label, requested)).items;
  }

  private async requestGraphQL(
    query: string,
    variables: Record<string, string | number>,
  ): Promise<unknown> {
    let lastError: GitLabApiError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(this.graphqlUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(process.env.GITLAB_TOKEN_TYPE?.toLowerCase() === "bearer"
              ? { Authorization: "Bearer " + this.token }
              : { "PRIVATE-TOKEN": this.token }),
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const bodyText = await response.text();
        let body: unknown = bodyText;
        try {
          body = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          // Keep the plain response text for useful error messages.
        }

        if (response.ok && isRecord(body) && body.data !== undefined) {
          if (Array.isArray(body.errors) && body.errors.length > 0) {
            throw new GitLabApiError(
              "GitLab GraphQL returned errors: " + safeApiBody(body.errors, this.token),
              response.status,
            );
          }
          return body.data;
        }

        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        lastError = new GitLabApiError(
          "GitLab GraphQL " +
            response.status +
            ": " +
            safeApiBody(body, this.token),
          response.status,
          retryAfter,
        );
        if (
          attempt >= MAX_RETRIES ||
          (response.status !== 429 && response.status < 500)
        ) {
          throw lastError;
        }
        await delay(retryAfter === null ? Math.min(1000 * 2 ** attempt, 5000) : Math.min(retryAfter * 1000, 5000));
      } catch (error: unknown) {
        if (error instanceof GitLabApiError) {
          throw error;
        }
        const message = redactGitLabToken(
          error instanceof Error ? error.message : String(error),
          this.token,
        );
        lastError = new GitLabApiError(
          "GitLab GraphQL request failed: " + message,
          0,
        );
        if (attempt >= MAX_RETRIES) {
          throw lastError;
        }
        await delay(Math.min(1000 * 2 ** attempt, 5000));
      }
    }
    throw lastError ?? new GitLabApiError("GitLab GraphQL request failed", 0);
  }

  private async requestWithMetadata<T>(
    path: string,
    options: {
      method?: string;
      form?: Record<string, string | number | boolean | Array<string | number | boolean> | undefined>;
      retryable?: boolean;
    } = {},
  ): Promise<{ body: T; headers: Headers }> {
    let lastError: GitLabApiError | null = null;
    const maxRetries = options.retryable === false ? 0 : MAX_RETRIES;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          Accept: "application/json",
          ...(options.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(process.env.GITLAB_TOKEN_TYPE?.toLowerCase() === "bearer"
            ? { Authorization: "Bearer " + this.token }
            : { "PRIVATE-TOKEN": this.token }),
        };
        const response = await fetch(this.baseUrl + path, {
          method: options.method ?? "GET",
          headers,
          ...(options.form ? { body: new URLSearchParams(stringifyForm(options.form)) } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const bodyText = await response.text();
        let body: unknown = bodyText;
        try {
          body = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          // Keep the plain response text for useful error messages.
        }

        if (response.ok) {
          return { body: body as T, headers: response.headers };
        }

        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        lastError = new GitLabApiError(
          "GitLab API " +
            response.status +
            " for " +
            path +
            ": " +
            safeApiBody(body, this.token),
          response.status,
          retryAfter,
        );
        if (
          attempt >= maxRetries ||
          (response.status !== 429 && response.status < 500)
        ) {
          throw lastError;
        }
        await delay(retryAfter === null ? Math.min(1000 * 2 ** attempt, 5000) : Math.min(retryAfter * 1000, 5000));
      } catch (error: unknown) {
        if (error instanceof GitLabApiError) {
          throw error;
        }
        const message = redactGitLabToken(
          error instanceof Error ? error.message : String(error),
          this.token,
        );
        lastError = new GitLabApiError(
          "GitLab API request failed for " + path + ": " + message,
          0,
        );
        if (attempt >= maxRetries) {
          throw lastError;
        }
        await delay(Math.min(1000 * 2 ** attempt, 5000));
      }
    }
    throw lastError ?? new GitLabApiError("GitLab API request failed", 0);
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      form?: Record<string, string | number | boolean | Array<string | number | boolean> | undefined>;
      retryable?: boolean;
    } = {},
  ): Promise<T> {
    return (await this.requestWithMetadata<T>(path, options)).body;
  }
}

function stringifyForm(
  form: Record<string, string | number | boolean | Array<string | number | boolean> | undefined>,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      const arrayKey = key.endsWith("[]") ? key : key + "[]";
      if (value.length === 0) {
        entries.push([arrayKey, ""]);
      } else {
        for (const item of value) {
          entries.push([arrayKey, String(item)]);
        }
      }
      continue;
    }
    entries.push([key, String(value)]);
  }
  return entries;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function parsePagination(
  headers: Headers,
  requested: number,
  returned: number,
): GitLabPagination {
  const page = parsePaginationHeader(headers.get("x-page"));
  const nextPage = parsePaginationHeader(headers.get("x-next-page"));
  const total = parsePaginationHeader(headers.get("x-total"), 0);
  const totalPages = parsePaginationHeader(headers.get("x-total-pages"));
  const hasNextFromTotals = page !== null && totalPages !== null && totalPages > page;
  const link = headers.get("link");
  const hasNextFromLink = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/i.test(link ?? "");
  const hasKnownPaginationHeaders = page !== null || nextPage !== null || total !== null || totalPages !== null || link !== null;
  return {
    returned,
    requested,
    page,
    nextPage,
    total,
    totalPages,
    hasNextPage: hasNextFromTotals || hasNextFromLink ||
      (!hasKnownPaginationHeaders && returned >= requested),
  };
}

function parsePaginationHeader(value: string | null, minimum = 1): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function formatApiBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return "unknown error";
  }
}

function safeApiBody(body: unknown, token: string): string {
  return redactGitLabToken(formatApiBody(body), token).slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseGroupEpic(value: unknown): GitLabGroupEpic {
  if (!isRecord(value) || typeof value.id !== "string" ||
    typeof value.iid !== "string" || !/^\d+$/.test(value.iid) ||
    typeof value.title !== "string") {
    throw new OflowError(
      "GitLab GraphQL returned an invalid group epic node.",
      "INVALID_GITLAB_RESPONSE",
    );
  }
  const iid = Number(value.iid);
  if (!Number.isSafeInteger(iid) || iid < 1) {
    throw new OflowError(
      "GitLab GraphQL returned an invalid group epic IID.",
      "INVALID_GITLAB_RESPONSE",
    );
  }
  return {
    id: value.id,
    iid,
    title: value.title,
    state: typeof value.state === "string" ? value.state : null,
    web_url: typeof value.webUrl === "string" ? value.webUrl : null,
  };
}

function parseIterationCadence(value: unknown): GitLabIterationCadence {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim() === "") {
    throw new OflowError(
      "GitLab GraphQL returned an invalid iteration-cadence node.",
      "INVALID_GITLAB_RESPONSE",
    );
  }
  return {
    id: value.id,
    title: typeof value.title === "string" ? value.title : null,
    active: typeof value.active === "boolean" ? value.active : null,
    automatic: typeof value.automatic === "boolean" ? value.automatic : null,
    duration_in_weeks: optionalSafeInteger(value.durationInWeeks),
    iterations_in_advance: optionalSafeInteger(value.iterationsInAdvance),
    roll_over: typeof value.rollOver === "boolean" ? value.rollOver : null,
    start_date: typeof value.startDate === "string" ? value.startDate : null,
  };
}

function optionalSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parseWorkItemReference(value: unknown): GitLabWorkItemReference {
  if (!isRecord(value) || typeof value.title !== "string") {
    throw new OflowError(
      "GitLab GraphQL returned an invalid epic hierarchy reference.",
      "INVALID_GITLAB_RESPONSE",
    );
  }
  let iid: number | null = null;
  if (typeof value.iid === "string" && /^\d+$/.test(value.iid)) {
    const parsed = Number(value.iid);
    iid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } else if (typeof value.iid === "number" && Number.isSafeInteger(value.iid) && value.iid > 0) {
    iid = value.iid;
  }
  return {
    id: typeof value.id === "string" ? value.id : null,
    iid,
    title: value.title,
    web_url: typeof value.webUrl === "string" ? value.webUrl : null,
    type: isRecord(value.workItemType) && typeof value.workItemType.name === "string"
      ? value.workItemType.name
      : null,
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
