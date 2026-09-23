/**
 * Backend-neutral action execution (vNext architecture, PR 7).
 *
 * Executes one approved canonical action through the best available
 * authenticated backend, resolved at execution time:
 *
 *   - REST when a direct token (environment or oflow store) exists,
 *   - glab api when only glab is authenticated,
 *   - otherwise the apply is refused with a clear credential message.
 *
 * Policy, approval, stale preconditions, and verification stay owned by
 * oflow regardless of the transport that performed the write.
 */

import { getGitLabToken } from "./auth.js";
import { resolveAuth } from "./auth-resolver.js";
import { OflowError } from "./errors.js";
import { glabApiGet, glabApiMutation } from "./glab.js";
import type { GitLabIssue, GitLabIssueUpdate } from "./types.js";

export type ExecutionBackendId = "rest" | "glab";

export interface ExecutionOutcome {
  backend: ExecutionBackendId;
  issue: GitLabIssue;
}

function issueEndpoint(projectPath: string, issueIid: number): string {
  return "projects/" + encodeURIComponent(projectPath) + "/issues/" + String(issueIid);
}

function changesToFields(changes: GitLabIssueUpdate): Record<string, string> {
  const fields: Record<string, string> = {};
  if (changes.title !== undefined) fields.title = changes.title;
  if (changes.description !== undefined) fields.description = changes.description;
  if (changes.state_event !== undefined) fields.state_event = changes.state_event;
  if (changes.issue_type !== undefined) fields.issue_type = changes.issue_type;
  if (changes.labels !== undefined) fields.labels = changes.labels;
  if (changes.add_labels !== undefined) {
    fields.add_labels = Array.isArray(changes.add_labels)
      ? changes.add_labels.join(",")
      : changes.add_labels;
  }
  if (changes.remove_labels !== undefined) {
    fields.remove_labels = Array.isArray(changes.remove_labels)
      ? changes.remove_labels.join(",")
      : changes.remove_labels;
  }
  if (changes.milestone !== undefined) fields.milestone = changes.milestone;
  if (changes.milestone_id !== undefined) {
    fields.milestone_id = String(changes.milestone_id);
  }
  if (changes.epic_id !== undefined) fields.epic_id = String(changes.epic_id);
  if (changes.due_date !== undefined) fields.due_date = changes.due_date;
  if (changes.weight !== undefined) fields.weight = String(changes.weight);
  if (changes.assignee_ids !== undefined) {
    fields.assignee_ids = changes.assignee_ids.join(",");
  }
  return fields;
}

/**
 * Execute an approved issue update. The caller has already enforced plan
 * state, digest, and target binding; the stale precondition check below is
 * transport-independent because it re-reads through the same backend.
 */
export async function executeIssueUpdate(options: {
  root: string;
  host: string;
  projectPath: string;
  issueIid: number;
  changes: GitLabIssueUpdate;
  expectedUpdatedAt?: string | null;
  /** REST client getter so this module stays free of direct GitLabClient imports. */
  createRestClient: () => {
    getIssue(projectPath: string, issueIid: number): Promise<GitLabIssue>;
    updateIssue(
      projectPath: string,
      issueIid: number,
      changes: GitLabIssueUpdate,
    ): Promise<GitLabIssue>;
  };
}): Promise<ExecutionOutcome> {
  const { root, host, projectPath, issueIid, changes, expectedUpdatedAt } = options;

  if (getGitLabToken(host)) {
    const client = options.createRestClient();
    await assertIssueFreshThrough(
      () => client.getIssue(projectPath, issueIid),
      issueIid,
      expectedUpdatedAt,
    );
    const issue = await client.updateIssue(projectPath, issueIid, changes);
    return { backend: "rest", issue };
  }

  const auth = await resolveAuth({ host, root, detectMcp: false });
  const glabAuthenticated = auth.sources.some(
    (source) => source.source === "glab" && source.authenticated === true,
  );
  if (!glabAuthenticated) {
    throw new OflowError(
      "No authenticated execution backend. Run oflow auth login, set GITLAB_TOKEN, or authenticate glab (glab auth login).",
      "MISSING_EXECUTION_BACKEND",
    );
  }

  await assertIssueFreshThrough(
    () => glabReadIssue(root, host, projectPath, issueIid),
    issueIid,
    expectedUpdatedAt,
  );
  const result = await glabApiMutation({
    root,
    host,
    endpoint: issueEndpoint(projectPath, issueIid),
    method: "PUT",
    fields: changesToFields(changes),
  });
  if (!isIssueLike(result)) {
    throw new OflowError(
      "glab returned an invalid issue response for the approved update.",
      "INVALID_GLAB_RESPONSE",
    );
  }
  return { backend: "glab", issue: result };
}

async function glabReadIssue(
  root: string,
  host: string,
  projectPath: string,
  issueIid: number,
): Promise<GitLabIssue> {
  const result = await glabApiGet({
    root,
    host,
    endpoint: issueEndpoint(projectPath, issueIid),
  });
  if (!isIssueLike(result)) {
    throw new OflowError(
      "glab returned an invalid issue response.",
      "INVALID_GLAB_RESPONSE",
    );
  }
  return result;
}

function isIssueLike(value: unknown): value is GitLabIssue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as GitLabIssue).iid === "number" &&
    typeof (value as GitLabIssue).title === "string"
  );
}

async function assertIssueFreshThrough(
  readIssue: () => Promise<GitLabIssue>,
  issueIid: number,
  expectedUpdatedAt?: string | null,
): Promise<void> {
  if (expectedUpdatedAt === undefined) {
    return;
  }
  const current = await readIssue();
  const remoteUpdatedAt = current.updated_at ?? null;
  if (remoteUpdatedAt !== expectedUpdatedAt) {
    throw new OflowError(
      "Issue !" +
        issueIid +
        " changed after planning (updated_at " +
        (remoteUpdatedAt ?? "unknown") +
        " vs expected " +
        expectedUpdatedAt +
        "). Create a new plan from current state.",
      "PLAN_TARGET_CHANGED",
    );
  }
}
