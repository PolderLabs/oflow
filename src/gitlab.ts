import { OflowError } from "./errors.js";
import { getGitLabToken, redactGitLabToken } from "./auth.js";
import type {
  GitLabIssue,
  GitLabIssueUpdate,
  GitLabBoard,
  GitLabBoardList,
  GitLabIteration,
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
} from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

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
  private readonly token: string;

  constructor(host: string, token = getGitLabToken(host)) {
    if (!token) {
      throw new OflowError(
        "No GitLab token found. Run oflow auth login or set GITLAB_TOKEN for API-backed commands.",
        "MISSING_GITLAB_TOKEN",
      );
    }
    this.baseUrl = "https://" + host.replace(/^https?:\/\//, "").replace(/\/$/, "") + "/api/v4";
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

  async listIssues(
    projectPath: string,
    state: IssueState = "opened",
    limit = 100,
  ): Promise<GitLabIssue[]> {
    const result = await this.request<unknown>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/issues?state=" +
        encodeURIComponent(state) +
        "&per_page=" + String(limit) + "&order_by=updated_at&sort=desc",
    );
    if (!Array.isArray(result)) {
      throw new OflowError(
        "GitLab API returned an invalid issue list response.",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    return result as GitLabIssue[];
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
      { method: "PUT", form: changes as Record<string, string | number | boolean | undefined> },
    );
  }

  async listLabels(projectPath: string, limit = 100): Promise<GitLabLabel[]> {
    return this.listResponse<GitLabLabel>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/labels?per_page=" +
        String(limit) +
        "&with_counts=true",
      "label list",
    );
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

  async listMilestones(
    projectPath: string,
    state: "active" | "closed" | "all" = "active",
    limit = 100,
  ): Promise<GitLabMilestone[]> {
    const stateQuery = state === "all" ? "" : "&state=" + state;
    return this.listResponse<GitLabMilestone>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/milestones?per_page=" +
        String(limit) +
        stateQuery +
        "&include_ancestors=true",
      "milestone list",
    );
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

  async listBoards(projectPath: string, limit = 100): Promise<GitLabBoard[]> {
    return this.listResponse<GitLabBoard>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/boards?per_page=" +
        String(limit),
      "board list",
    );
  }

  async listBoardLists(
    projectPath: string,
    boardId: number,
    limit = 100,
  ): Promise<GitLabBoardList[]> {
    return this.listResponse<GitLabBoardList>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/boards/" +
        String(boardId) +
        "/lists?per_page=" +
        String(limit),
      "board list entries",
    );
  }

  async listGroupIterations(
    groupPath: string,
    state: "opened" | "upcoming" | "current" | "closed" | "all" = "all",
    limit = 100,
  ): Promise<GitLabIteration[]> {
    const stateQuery = state === "all" ? "" : "&state=" + state;
    return this.listResponse<GitLabIteration>(
      "/groups/" +
        encodeURIComponent(groupPath) +
        "/iterations?per_page=" +
        String(limit) +
        stateQuery +
        "&include_ancestors=true",
      "iteration list",
    );
  }

  async listProjectIterations(
    projectPath: string,
    state: "opened" | "upcoming" | "current" | "closed" | "all" = "all",
    limit = 100,
  ): Promise<GitLabIteration[]> {
    const stateQuery = state === "all" ? "" : "&state=" + state;
    return this.listResponse<GitLabIteration>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/iterations?per_page=" +
        String(limit) +
        stateQuery +
        "&include_ancestors=true",
      "project iteration list",
    );
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

  async listMergeRequests(
    projectPath: string,
    storyIid?: number,
    state: IssueState = storyIid ? "all" : "opened",
    limit = 20,
  ): Promise<GitLabMergeRequest[]> {
    const result = await this.listResponse<GitLabMergeRequest>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/merge_requests?state=" +
        encodeURIComponent(state) +
        "&per_page=" +
        String(limit) +
        (storyIid ? "&search=" + encodeURIComponent("#" + storyIid) : ""),
      "merge request list",
    );
    if (!storyIid) {
      return result;
    }
    return result.filter((mergeRequest) => {
      const text =
        String(mergeRequest.title ?? "") +
        "\n" +
        String(mergeRequest.description ?? "") +
        "\n" +
        String(mergeRequest.source_branch ?? "");
      return new RegExp("#" + storyIid + "\\b").test(text) ||
        new RegExp("\\b(?:story|feature|fix|chore)[^\\n]*" + storyIid + "\\b", "i").test(text);
    });
  }

  async listRelatedMergeRequests(
    projectPath: string,
    issueIid: number,
    limit = 20,
  ): Promise<GitLabMergeRequest[]> {
    return this.listResponse<GitLabMergeRequest>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/issues/" +
        String(issueIid) +
        "/related_merge_requests?per_page=" +
        String(limit),
      "related merge request list",
    );
  }

  async listPipelines(
    projectPath: string,
    ref?: string | null,
    limit = 20,
  ): Promise<GitLabPipeline[]> {
    const query = ref ? "&ref=" + encodeURIComponent(ref) : "";
    return this.request<GitLabPipeline[]>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/pipelines?per_page=" + String(limit) + "&order_by=id&sort=desc" +
        query,
    );
  }

  private async listResponse<T>(path: string, label: string): Promise<T[]> {
    const result = await this.request<unknown>(path);
    if (!Array.isArray(result)) {
      throw new OflowError(
        "GitLab API returned an invalid " + label + " response.",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    return result as T[];
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      form?: Record<string, string | number | boolean | undefined>;
      retryable?: boolean;
    } = {},
  ): Promise<T> {
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
          return body as T;
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
}

function stringifyForm(
  form: Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(form)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
