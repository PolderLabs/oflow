import { OflowError } from "./errors.js";
import { getGitLabToken, redactGitLabToken } from "./auth.js";
import type {
  GitLabIssue,
  GitLabMergeRequest,
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
  ): Promise<GitLabIssue[]> {
    const result = await this.request<unknown>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/issues?state=" +
        encodeURIComponent(state) +
        "&per_page=100&order_by=updated_at&sort=desc",
    );
    if (!Array.isArray(result)) {
      throw new OflowError(
        "GitLab API returned an invalid issue list response.",
        "INVALID_GITLAB_RESPONSE",
      );
    }
    return result as GitLabIssue[];
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

  async listMergeRequests(
    projectPath: string,
    storyIid: number,
  ): Promise<GitLabMergeRequest[]> {
    const result = await this.request<GitLabMergeRequest[]>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/merge_requests?state=all&per_page=100&search=" +
        encodeURIComponent("#" + storyIid),
    );
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

  async listPipelines(
    projectPath: string,
    ref?: string | null,
  ): Promise<GitLabPipeline[]> {
    const query = ref ? "&ref=" + encodeURIComponent(ref) : "";
    return this.request<GitLabPipeline[]>(
      "/projects/" +
        encodeURIComponent(projectPath) +
        "/pipelines?per_page=20&order_by=id&sort=desc" +
        query,
    );
  }

  private async request<T>(path: string): Promise<T> {
    let lastError: GitLabApiError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(this.baseUrl + path, {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(process.env.GITLAB_TOKEN_TYPE?.toLowerCase() === "bearer"
              ? { Authorization: "Bearer " + this.token }
              : { "PRIVATE-TOKEN": this.token }),
          },
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
          "GitLab API request failed for " + path + ": " + message,
          0,
        );
        if (attempt >= MAX_RETRIES) {
          throw lastError;
        }
        await delay(Math.min(1000 * 2 ** attempt, 5000));
      }
    }
    throw lastError ?? new GitLabApiError("GitLab API request failed", 0);
  }
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
