import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readAudit, recordPlanEvent } from "./audit.js";
import { loadConfig } from "./config.js";
import { OflowError } from "./errors.js";
import { readJson, writeJson } from "./fs.js";
import { getCurrentBranch, getGitLabRemote } from "./git.js";
import { GitLabApiError, GitLabClient } from "./gitlab.js";
import { normalizeForbidden } from "./auth-resolver.js";
import { executeIssueUpdate } from "./executor.js";
import {
  convertBulletsToAcceptanceCriteria,
  parseAcceptanceCriteria,
  setCriterionChecked,
  countChecklistItems,
  type CriterionStateChange,
} from "./criteria.js";
import { isIssueType, type GitLabUser } from "./types.js";
import type { DelegatedActionRequest, ExecutionReceipt } from "./actions.js";
import type {
  GitLabIssue,
  GitLabIssueCreate,
  GitLabIssueUpdate,
  IssueType,
  GitLabBoard,
  GitLabBoardList,
  GitLabBoardUpdate,
  GitLabLabel,
  GitLabLabelCreate,
  GitLabLabelUpdate,
  GitLabMilestone,
  GitLabMilestoneCreate,
  GitLabMilestoneUpdate,
  GitLabNote,
  GitLabMergeRequest,
  GitLabIteration,
} from "./types.js";

export const PLAN_DIRECTORY = ".oflow/state/plans";
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BULK_ISSUES = 50;

export type PlanState = "draft" | "approved" | "applied" | "applied-partial" | "verified";

export interface IssueUpdateOperation {
  kind: "issue.update";
  host: string;
  projectPath: string;
  issueIid: number;
  changes: GitLabIssueUpdate;
  expectedUpdatedAt?: string | null;
}

/**
 * Ticks one acceptance criterion and records the change in an issue note in a
 * single approved plan. GitLab derives `task_completion_status` by parsing
 * `- [ ]` / `- [x]` bullets out of the issue description, and exposes no
 * writable field for it, so the description write is the only way to change
 * task completion. The note rides along so the audit trail cannot drift from
 * the tick: one plan, one approval, one apply.
 */
export interface IssueCriterionToggleOperation {
  kind: "issue.criterion.toggle";
  host: string;
  projectPath: string;
  issueIid: number;
  changes: GitLabIssueUpdate;
  criterion: {
    id: string;
    checked: boolean;
  };
  note: string;
  expectedUpdatedAt?: string | null;
}

export interface IssueIterationUpdateOperation {
  kind: "issue.iteration.update";
  host: string;
  projectPath: string;
  issueIid: number;
  iterationId: string | null;
  iterationIid: number | null;
  iterationTitle: string | null;
  expectedUpdatedAt?: string | null;
}

export interface AssessmentPlanSource {
  generatedAt: string;
  status: string;
  recommendations: string[];
}

export interface BulkIssueLabelsUpdateOperation {
  kind: "issues.labels.update";
  host: string;
  projectPath: string;
  issueIids: number[];
  add_labels?: string;
  remove_labels?: string;
  expectedUpdatedAt?: Record<string, string | null>;
}

export interface BulkIssuePlanningUpdateOperation {
  kind: "issues.planning.update";
  host: string;
  projectPath: string;
  issueIids: number[];
  changes: Pick<GitLabIssueUpdate, "milestone" | "milestone_id" | "assignee_ids">;
  expectedUpdatedAt?: Record<string, string | null>;
}

export interface BulkIssueIterationUpdateOperation {
  kind: "issues.iteration.update";
  host: string;
  projectPath: string;
  issueIids: number[];
  iterationId: string | null;
  iterationIid: number | null;
  iterationTitle: string | null;
  expectedUpdatedAt?: Record<string, string | null>;
}

export interface IssueCreateOperation {
  kind: "issue.create";
  host: string;
  projectPath: string;
  issue: GitLabIssueCreate;
}

export interface IssueNoteCreateOperation {
  kind: "issue.note.create";
  host: string;
  projectPath: string;
  issueIid: number;
  body: string;
}

export interface BulkIssueNotesCreateOperation {
  kind: "issues.notes.create";
  host: string;
  projectPath: string;
  issueIids: number[];
  body: string;
  expectedUpdatedAt?: Record<string, string | null>;
}

export interface LabelCreateOperation {
  kind: "label.create";
  host: string;
  projectPath: string;
  name: string;
  color: string;
  description?: string;
}

export interface LabelUpdateOperation {
  kind: "label.update";
  host: string;
  projectPath: string;
  label: string;
  labelId?: number;
  changes: GitLabLabelUpdate;
}

export interface MilestoneCreateOperation {
  kind: "milestone.create";
  host: string;
  projectPath: string;
  title: string;
  description?: string;
  start_date?: string;
  due_date?: string;
}

export interface MilestoneUpdateOperation {
  kind: "milestone.update";
  host: string;
  projectPath: string;
  milestoneIid: number;
  changes: GitLabMilestoneUpdate;
}

export interface BoardCreateOperation {
  kind: "board.create";
  host: string;
  projectPath: string;
  name: string;
}

export interface BoardUpdateOperation {
  kind: "board.update";
  host: string;
  projectPath: string;
  boardId: number;
  changes: GitLabBoardUpdate;
}

export interface BoardListCreateOperation {
  kind: "board-list.create";
  host: string;
  projectPath: string;
  boardId: number;
  labelId: number;
  labelName: string;
}

export interface BoardListUpdateOperation {
  kind: "board-list.update";
  host: string;
  projectPath: string;
  boardId: number;
  listId: number;
  position: number;
}

/**
 * Delegated-only delivery action (vNext PR 10): the plan describes the MR
 * intent; an agent runtime executes it through its GitLab MCP tool and
 * oflow independently verifies the postconditions. There is no direct
 * oflow-side execution path for this operation.
 */
export interface MergeRequestCreateOperation {
  kind: "merge_request.create";
  host: string;
  projectPath: string;
  storyIid: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  removeSourceBranch?: boolean;
  squash?: boolean;
}

/**
 * Direct-execution update for an existing merge request (F3): the MR must
 * already exist.  Description is the canonical body, optionally supplied via
 * --description-file on the CLI; both paths preserve multiline text.  The
 * pre-apply diff + no-op detection path applies automatically because
 * loadApplySnapshot already covers every read-backed op kind.
 */
export interface MergeRequestUpdateOperation {
  kind: "merge_request.update";
  host: string;
  projectPath: string;
  iid: number;
  /** Captured at plan time so --force can prove absence of drift. */
  expectedUpdatedAt?: string | null;
  changes: {
    title?: string;
    description?: string;
    state_event?: "close" | "reopen";
    target_branch?: string;
  };
}


export type PlanOperation =
  | IssueCreateOperation
  | IssueUpdateOperation
  | IssueCriterionToggleOperation
  | IssueIterationUpdateOperation
  | BulkIssueLabelsUpdateOperation
  | BulkIssuePlanningUpdateOperation
  | BulkIssueIterationUpdateOperation
  | IssueNoteCreateOperation
  | BulkIssueNotesCreateOperation
  | LabelCreateOperation
  | LabelUpdateOperation
  | MilestoneCreateOperation
  | MilestoneUpdateOperation
  | BoardCreateOperation
  | BoardUpdateOperation
  | BoardListCreateOperation
  | BoardListUpdateOperation
  | MergeRequestCreateOperation
  | MergeRequestUpdateOperation;


export const DELEGATED_ONLY_OPERATIONS = ["merge_request.create"] as const;

export interface PlanArtifact {
  managedBy: "oflow";
  version: 2;
  id: string;
  createdAt: string;
  sessionId?: string;
  expiresAt?: string;
  updatedAt: string;
  state: PlanState;
  digest: string;
  operation: PlanOperation;
  sourceAssessment?: AssessmentPlanSource;
  result?: {
    kind: PlanOperation["kind"];
    iid?: number;
    title?: string;
    body?: string;
    state?: string | null;
    issueType?: string | null;
    webUrl?: string | null;
    iterationId?: string | null;
    iterationIid?: number | null;
    iterationTitle?: string | null;
    noteId?: number;
    criterion?: { id: string; checked: boolean };
    labelId?: number;
    name?: string;
    color?: string;
    description?: string | null;
    noteReused?: boolean;
    resourceReused?: boolean;
    milestoneId?: number;
    milestoneIid?: number;
    boardId?: number;
    listId?: number;
    position?: number;
    issues?: Array<{
      iid: number;
      labels?: string[];
      milestone?: string | null;
      assigneeIds?: number[];
      iterationId?: string | null;
      iterationIid?: number | null;
      iterationTitle?: string | null;
      noteId?: number;
      noteReused?: boolean;
    }>;
  };
  execution?: {
    backend: "rest" | "glab" | "gitlab-mcp";
  };
  delegatedReceipt?: {
    backend: "gitlab-mcp";
    action: string;
    executedAt: string;
    resultIid?: number;
    resultUrl?: string;
    error?: string;
  };
  verification?: PlanVerification;
  applyError?: {
    code: string;
    message: string;
    completed: number;
  };
  /**
   * Live pre-apply snapshot: target IID, current title, and the before/after
   * diff for every planned field.  Recorded during apply so users can audit
   * what was about to be mutated, even on JSON output.
   */
  preview?: ApplyPreview;
  /**
   * When true, apply detected that the live remote state already matched the
   * planned change; no mutation was issued and state advanced to "verified".
   */
  noOp?: true;
}

export interface ApplyPreviewFieldDiff {
  field: string;
  before: string | null;
  after: string | null;
}

export interface ApplyPreview {
  operation: PlanOperation["kind"];
  host: string;
  projectPath: string;
  iid?: number;
  currentTitle?: string | null;
  fields: ApplyPreviewFieldDiff[];
  fetchedAt: string;
}

export interface ApplyPreviewResult {
  equivalent: { equivalent: boolean; reason?: string };
  preview: ApplyPreview | null;
}


export interface StoredPlan {
  path: string;
  plan: PlanArtifact;
}

export interface PlanVerification {
  passed: boolean;
  checks: Array<{
    field: string;
    expected: string;
    actual: string;
    passed: boolean;
  }>;
  reasons: string[];
}

export async function createIssueCreatePlan(
  root: string,
  issue: GitLabIssueCreate,
  assignee?: string,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  if (assignee !== undefined && issue.assignee_ids !== undefined) {
    throw new OflowError(
      "Use either --assignee or assignee_ids, not both.",
      "DUPLICATE_ASSIGNEE_INPUT",
    );
  }
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  await client.getProject(remote.projectPath);
  const operationIssue = validateIssueCreate({
    ...issue,
    assignee_ids: assignee === undefined
      ? issue.assignee_ids
      : await resolveAssigneeIds(client, assignee),
  });

  const now = new Date().toISOString();
  const plan: PlanArtifact = {
    managedBy: "oflow",
    version: 2,
    id: randomUUID(),
    createdAt: now,
    sessionId: currentPlanSession(),
    expiresAt: new Date(Date.parse(now) + PLAN_TTL_MS).toISOString(),
    updatedAt: now,
    state: "draft",
    digest: "",
    operation: {
      kind: "issue.create",
      host: remote.host,
      projectPath: remote.projectPath,
      issue: operationIssue,
    },
  };
  plan.digest = planDigest(plan);
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeJson(path, plan);
  await recordPlanEvent(root, plan, "created");
  return { path, plan };
}

export async function createIssueUpdatePlan(
  root: string,
  issueIid: number,
  changes: GitLabIssueUpdate,
  assignee?: string,
  sourceAssessment?: AssessmentPlanSource,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  validateIssueIid(issueIid);
  if (assignee !== undefined && changes.assignee_ids !== undefined) {
    throw new OflowError(
      "Use either --assignee or assignee_ids, not both.",
      "DUPLICATE_ASSIGNEE_INPUT",
    );
  }
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const currentIssue = await client.getIssue(remote.projectPath, issueIid);
  const operationChanges = validateIssueChanges(
    cleanChanges({
      ...changes,
      assignee_ids: assignee === undefined
        ? changes.assignee_ids
        : await resolveAssigneeIds(client, assignee),
    }),
  );
  if (Object.keys(operationChanges).length === 0) {
    throw new OflowError(
      "No issue changes were provided. Use --title, --description, --type, --labels, --add-labels, --remove-labels, --milestone, --epic, --due-date, --weight, --assignee, or --state.",
      "EMPTY_PLAN",
    );
  }
  if (operationChanges.add_labels !== undefined) {
    await assertIssueLabelsExist(
      client,
      remote.projectPath,
      validateIssueLabelList(operationChanges.add_labels, "Added issue labels"),
    );
  }

  const now = new Date().toISOString();
  const plan: PlanArtifact = {
    managedBy: "oflow",
    version: 2,
    id: randomUUID(),
    createdAt: now,
    sessionId: currentPlanSession(),
    expiresAt: new Date(Date.parse(now) + PLAN_TTL_MS).toISOString(),
    updatedAt: now,
    state: "draft",
    digest: "",
    operation: {
      kind: "issue.update",
      host: remote.host,
      projectPath: remote.projectPath,
      issueIid,
      changes: operationChanges,
      expectedUpdatedAt: currentIssue.updated_at ?? null,
    },
    sourceAssessment,
  };
  plan.digest = planDigest(plan);
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeJson(path, plan);
  await recordPlanEvent(root, plan, "created");
  return { path, plan };
}

export async function createIssueIterationUpdatePlan(
  root: string,
  issueIid: number,
  iterationReference: string,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  validateIssueIid(issueIid);
  const reference = requiredText(iterationReference, "Iteration");
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const currentIssue = await client.getIssue(remote.projectPath, issueIid);
  if (isIterationClearReference(reference)) {
    return writePlan(root, {
      kind: "issue.iteration.update",
      host: remote.host,
      projectPath: remote.projectPath,
      issueIid,
      iterationId: null,
      iterationIid: null,
      iterationTitle: null,
      expectedUpdatedAt: currentIssue.updated_at ?? null,
    });
  }
  const target = resolveIterationTargetSafe(
    await safeProjectIterations(client, remote.projectPath),
    reference,
  );
  if (target === null) {
    // F6: group-only / unsupported iteration lookup — accept an already
    // equivalent project milestone as the timebox instead of failing.
    const milestoneTitle = namedValue(currentIssue.milestone);
    if (milestoneTitle && milestoneTitle.trim().toLowerCase() === reference.trim().toLowerCase()) {
      throw new OflowError(
        "Iteration " + JSON.stringify(reference) + " is not project-visible, but issue #" +
          String(issueIid) + " already has equivalent milestone " + JSON.stringify(milestoneTitle) +
          "; no mutation is required.",
        "TIMEBOX_ALREADY_EQUIVALENT",
      );
    }
    throw new OflowError(
      "Could not find project-visible iteration " + JSON.stringify(reference) + ". Use its exact title, IID, or none.",
      "ITERATION_NOT_FOUND",
    );
  }
  return writePlan(root, {
    kind: "issue.iteration.update",
    host: remote.host,
    projectPath: remote.projectPath,
    issueIid,
    iterationId: target.iterationId,
    iterationIid: target.iterationIid,
    iterationTitle: target.iterationTitle,
    expectedUpdatedAt: currentIssue.updated_at ?? null,
  });
}

export async function createBulkIssueLabelsPlan(
  root: string,
  issueIids: number[],
  changes: Pick<GitLabIssueUpdate, "add_labels" | "remove_labels">,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  const normalizedIids = validateIssueIids(issueIids);
  const operationChanges = validateBulkIssueLabelChanges(changes);
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const currentIssues = await Promise.all(
    normalizedIids.map((issueIid) => client.getIssue(remote.projectPath, issueIid)),
  );
  if (operationChanges.add_labels !== undefined) {
    await assertIssueLabelsExist(
      client,
      remote.projectPath,
      validateIssueLabelList(operationChanges.add_labels, "Added issue labels"),
    );
  }
  return writePlan(root, {
    kind: "issues.labels.update",
    host: remote.host,
    projectPath: remote.projectPath,
    issueIids: normalizedIids,
    ...operationChanges,
    expectedUpdatedAt: expectedUpdatedAtFor(currentIssues),
  });
}

export async function createBulkIssuePlanningPlan(
  root: string,
  issueIids: number[],
  changes: Pick<GitLabIssueUpdate, "milestone" | "milestone_id" | "assignee_ids">,
  assignee?: string,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  const normalizedIids = validateIssueIids(issueIids);
  if (assignee !== undefined && changes.assignee_ids !== undefined) {
    throw new OflowError(
      "Use either --assignee or assignee_ids, not both.",
      "DUPLICATE_ASSIGNEE_INPUT",
    );
  }
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const operationChanges = validateBulkIssuePlanningChanges(
    cleanChanges({
      ...changes,
      assignee_ids: assignee === undefined
        ? changes.assignee_ids
        : await resolveAssigneeIds(client, assignee),
    }),
  );
  const currentIssues = await Promise.all(
    normalizedIids.map((issueIid) => client.getIssue(remote.projectPath, issueIid)),
  );
  return writePlan(root, {
    kind: "issues.planning.update",
    host: remote.host,
    projectPath: remote.projectPath,
    issueIids: normalizedIids,
    changes: operationChanges,
    expectedUpdatedAt: expectedUpdatedAtFor(currentIssues),
  });
}

export async function createBulkIssueIterationPlan(
  root: string,
  issueIids: number[],
  iterationReference: string,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  const normalizedIids = validateIssueIids(issueIids);
  const reference = requiredText(iterationReference, "Iteration");
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const currentIssues = await Promise.all(
    normalizedIids.map((issueIid) => client.getIssue(remote.projectPath, issueIid)),
  );
  if (isIterationClearReference(reference)) {
    return writePlan(root, {
      kind: "issues.iteration.update",
      host: remote.host,
      projectPath: remote.projectPath,
      issueIids: normalizedIids,
      iterationId: null,
      iterationIid: null,
      iterationTitle: null,
      expectedUpdatedAt: expectedUpdatedAtFor(currentIssues),
    });
  }
  const target = resolveIterationTargetSafe(
    await safeProjectIterations(client, remote.projectPath),
    reference,
  );
  if (target === null) {
    const allEquivalent = currentIssues.every((issue) => {
      const milestoneTitle = namedValue(issue.milestone);
      return Boolean(milestoneTitle) &&
        milestoneTitle!.trim().toLowerCase() === reference.trim().toLowerCase();
    });
    if (allEquivalent) {
      throw new OflowError(
        "Iteration " + JSON.stringify(reference) + " is not project-visible, but every targeted issue " +
          "already has an equivalent milestone; no mutation is required.",
        "TIMEBOX_ALREADY_EQUIVALENT",
      );
    }
    throw new OflowError(
      "Could not find project-visible iteration " + JSON.stringify(reference) + ". Use its exact title, IID, or none.",
      "ITERATION_NOT_FOUND",
    );
  }
  return writePlan(root, {
    kind: "issues.iteration.update",
    host: remote.host,
    projectPath: remote.projectPath,
    issueIids: normalizedIids,
    iterationId: target.iterationId,
    iterationIid: target.iterationIid,
    iterationTitle: target.iterationTitle,
    expectedUpdatedAt: expectedUpdatedAtFor(currentIssues),
  });
}

export async function createIssueNotePlan(
  root: string,
  issueIid: number,
  body: string,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  validateIssueIid(issueIid);
  if (!body.trim()) {
    throw new OflowError(
      "Note body cannot be empty. Use --body with the progress or blocker update.",
      "EMPTY_PLAN",
    );
  }

  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  await client.getIssue(remote.projectPath, issueIid);

  return writePlan(root, {
    kind: "issue.note.create",
    host: remote.host,
    projectPath: remote.projectPath,
    issueIid,
    body,
  });
}

export async function createBulkIssueNotesPlan(
  root: string,
  issueIids: number[],
  body: string,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  const normalizedIids = validateIssueIids(issueIids);
  if (!body.trim()) {
    throw new OflowError(
      "Note body cannot be empty. Use --body with the shared progress or blocker update.",
      "EMPTY_PLAN",
    );
  }
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const currentIssues = await Promise.all(
    normalizedIids.map((issueIid) => client.getIssue(remote.projectPath, issueIid)),
  );
  return writePlan(root, {
    kind: "issues.notes.create",
    host: remote.host,
    projectPath: remote.projectPath,
    issueIids: normalizedIids,
    body,
    expectedUpdatedAt: expectedUpdatedAtFor(currentIssues),
  });
}

/**
 * F4: explicit acceptance-criteria conversion. Loads the live description,
 * turns eligible plain bullets into stable checklist criteria, and plans a
 * description update. Never rewrites descriptions on its own.
 */
export async function createIssueConvertAcPlan(
  root: string,
  issueIid: number,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  validateIssueIid(issueIid);
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const currentIssue = await client.getIssue(remote.projectPath, issueIid);
  const conversion = convertBulletsToAcceptanceCriteria(currentIssue.description);
  if (!conversion.changed) {
    throw new OflowError(
      "No eligible plain bullets found to convert under Acceptance criteria, Done when, or equivalent headings.",
      "EMPTY_PLAN",
    );
  }
  return writePlan(root, {
    kind: "issue.update",
    host: remote.host,
    projectPath: remote.projectPath,
    issueIid,
    changes: { description: conversion.description },
    expectedUpdatedAt: currentIssue.updated_at ?? null,
  });
}

/**
 * Plans a single acceptance-criterion tick (or untick) plus its audit note.
 *
 * Reads the live issue, rewrites only the matching checkbox, and captures
 * `expectedUpdatedAt` so a concurrent edit is rejected at apply time instead
 * of being clobbered. The progress note is rendered from GitLab's own
 * `task_completion_status` for the resulting description, so the number in
 * the note stays truthful.
 */
export async function createIssueCriterionTogglePlan(
  root: string,
  issueIid: number,
  reference: string,
  checked: boolean,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  validateIssueIid(issueIid);
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const currentIssue = await client.getIssue(remote.projectPath, issueIid);
  let toggle: CriterionStateChange;
  try {
    toggle = setCriterionChecked(currentIssue.description, reference, checked);
  } catch (error) {
    throw new OflowError(String(error instanceof Error ? error.message : error), "EMPTY_PLAN");
  }
  if (!toggle.changed) {
    throw new OflowError(
      checked
        ? "Acceptance criterion " + toggle.id + " is already checked."
        : "Acceptance criterion " + toggle.id + " is already unchecked.",
      "EMPTY_PLAN",
    );
  }
  // Count the resulting checklist exactly as GitLab will, so the note cannot
  // claim a total the issue does not have.
  const after = countChecklistItems(toggle.description);
  const completed = after.completed;
  const total = after.total;
  const note = checked
    ? "Marked " + toggle.id + " complete (" + completed + " of " + total + ")."
    : "Reopened " + toggle.id + " (" + completed + " of " + total + ").";
  return writePlan(root, {
    kind: "issue.criterion.toggle",
    host: remote.host,
    projectPath: remote.projectPath,
    issueIid,
    changes: { description: toggle.description },
    criterion: { id: toggle.id, checked },
    note,
    expectedUpdatedAt: currentIssue.updated_at ?? null,
  });
}

export async function createLabelCreatePlan(
  root: string,
  label: GitLabLabelCreate,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  const name = requiredText(label.name, "Label name");
  const color = requiredText(label.color, "Label color");
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const labels = await client.listLabels(remote.projectPath);
  if (labels.some((item) => item.name === name)) {
    throw new OflowError(
      "A project label named " + JSON.stringify(name) + " already exists.",
      "LABEL_EXISTS",
    );
  }

  const now = new Date().toISOString();
  const plan: PlanArtifact = {
    managedBy: "oflow",
    version: 2,
    id: randomUUID(),
    createdAt: now,
    sessionId: currentPlanSession(),
    expiresAt: new Date(Date.parse(now) + PLAN_TTL_MS).toISOString(),
    updatedAt: now,
    state: "draft",
    digest: "",
    operation: {
      kind: "label.create",
      host: remote.host,
      projectPath: remote.projectPath,
      name,
      color,
      description: label.description,
    },
  };
  plan.digest = planDigest(plan);
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeJson(path, plan);
  await recordPlanEvent(root, plan, "created");
  return { path, plan };
}

export async function createLabelUpdatePlan(
  root: string,
  labelReference: string,
  changes: GitLabLabelUpdate,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  const label = requiredText(labelReference, "Label identifier");
  const operationChanges = cleanLabelChanges(changes);
  if (Object.keys(operationChanges).length === 0) {
    throw new OflowError(
      "No label changes were provided. Use --new-name, --color, or --description.",
      "EMPTY_PLAN",
    );
  }

  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const labels = await client.listLabels(remote.projectPath);
  const current = findLabel(labels, label);
  if (!current) {
    throw new OflowError(
      "Could not find project label " + JSON.stringify(label) + ".",
      "LABEL_NOT_FOUND",
    );
  }
  if (
    operationChanges.new_name !== undefined &&
    labels.some((item) => item !== current && item.name === operationChanges.new_name)
  ) {
    throw new OflowError(
      "A project label named " + JSON.stringify(operationChanges.new_name) + " already exists.",
      "LABEL_EXISTS",
    );
  }

  const now = new Date().toISOString();
  const plan: PlanArtifact = {
    managedBy: "oflow",
    version: 2,
    id: randomUUID(),
    createdAt: now,
    sessionId: currentPlanSession(),
    expiresAt: new Date(Date.parse(now) + PLAN_TTL_MS).toISOString(),
    updatedAt: now,
    state: "draft",
    digest: "",
    operation: {
      kind: "label.update",
      host: remote.host,
      projectPath: remote.projectPath,
      label: current.name,
      labelId: current.id,
      changes: operationChanges,
    },
  };
  plan.digest = planDigest(plan);
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeJson(path, plan);
  await recordPlanEvent(root, plan, "created");
  return { path, plan };
}

export async function createMilestoneCreatePlan(
  root: string,
  milestone: GitLabMilestoneCreate,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  const title = requiredText(milestone.title, "Milestone title");
  const dates = validateMilestoneDates(milestone.start_date, milestone.due_date);
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const milestones = await client.listMilestones(remote.projectPath, "all");
  if (milestones.some((item) => item.title === title)) {
    throw new OflowError(
      "A project-visible milestone named " + JSON.stringify(title) + " already exists.",
      "MILESTONE_EXISTS",
    );
  }

  const now = new Date().toISOString();
  const plan: PlanArtifact = {
    managedBy: "oflow",
    version: 2,
    id: randomUUID(),
    createdAt: now,
    sessionId: currentPlanSession(),
    expiresAt: new Date(Date.parse(now) + PLAN_TTL_MS).toISOString(),
    updatedAt: now,
    state: "draft",
    digest: "",
    operation: {
      kind: "milestone.create",
      host: remote.host,
      projectPath: remote.projectPath,
      title,
      description: milestone.description,
      start_date: dates.startDate,
      due_date: dates.dueDate,
    },
  };
  plan.digest = planDigest(plan);
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeJson(path, plan);
  await recordPlanEvent(root, plan, "created");
  return { path, plan };
}

export async function createMilestoneUpdatePlan(
  root: string,
  milestoneIid: number,
  changes: GitLabMilestoneUpdate,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  validateMilestoneIid(milestoneIid);
  const operationChanges = validateMilestoneChanges(changes);
  if (Object.keys(operationChanges).length === 0) {
    throw new OflowError(
      "No milestone changes were provided. Use --title, --description, --start-date, --due-date, or --state.",
      "EMPTY_PLAN",
    );
  }

  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  await client.getMilestone(remote.projectPath, milestoneIid);

  const now = new Date().toISOString();
  const plan: PlanArtifact = {
    managedBy: "oflow",
    version: 2,
    id: randomUUID(),
    createdAt: now,
    sessionId: currentPlanSession(),
    expiresAt: new Date(Date.parse(now) + PLAN_TTL_MS).toISOString(),
    updatedAt: now,
    state: "draft",
    digest: "",
    operation: {
      kind: "milestone.update",
      host: remote.host,
      projectPath: remote.projectPath,
      milestoneIid,
      changes: operationChanges,
    },
  };
  plan.digest = planDigest(plan);
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeJson(path, plan);
  await recordPlanEvent(root, plan, "created");
  return { path, plan };
}

export async function createBoardCreatePlan(
  root: string,
  name: string,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  const normalizedName = requiredText(name, "Board name");
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const boards = await client.listBoards(remote.projectPath);
  if (boards.some((board) => board.name === normalizedName)) {
    throw new OflowError(
      "A project board named " + JSON.stringify(normalizedName) + " already exists.",
      "BOARD_EXISTS",
    );
  }
  const now = new Date().toISOString();
  const plan: PlanArtifact = {
    managedBy: "oflow",
    version: 2,
    id: randomUUID(),
    createdAt: now,
    sessionId: currentPlanSession(),
    expiresAt: new Date(Date.parse(now) + PLAN_TTL_MS).toISOString(),
    updatedAt: now,
    state: "draft",
    digest: "",
    operation: {
      kind: "board.create",
      host: remote.host,
      projectPath: remote.projectPath,
      name: normalizedName,
    },
  };
  plan.digest = planDigest(plan);
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeJson(path, plan);
  await recordPlanEvent(root, plan, "created");
  return { path, plan };
}

export async function createBoardUpdatePlan(
  root: string,
  boardId: number,
  changes: GitLabBoardUpdate,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  validateBoardId(boardId);
  const operationChanges = cleanBoardChanges(changes);
  if (Object.keys(operationChanges).length === 0) {
    throw new OflowError(
      "No board changes were provided. Use --name.",
      "EMPTY_PLAN",
    );
  }
  if (operationChanges.name !== undefined) {
    operationChanges.name = requiredText(operationChanges.name, "Board name");
  }
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const current = await client.getBoard(remote.projectPath, boardId);
  if (
    operationChanges.name !== undefined &&
    operationChanges.name !== current.name
  ) {
    const boards = await client.listBoards(remote.projectPath);
    if (boards.some((board) => board.id !== boardId && board.name === operationChanges.name)) {
      throw new OflowError(
        "A project board named " + JSON.stringify(operationChanges.name) + " already exists.",
        "BOARD_EXISTS",
      );
    }
  }
  return writePlan(root, {
    kind: "board.update",
    host: remote.host,
    projectPath: remote.projectPath,
    boardId,
    changes: operationChanges,
  });
}

export async function createBoardListCreatePlan(
  root: string,
  boardId: number,
  labelReference: string,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  validateBoardId(boardId);
  const label = requiredText(labelReference, "Board list label");
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  await client.getBoard(remote.projectPath, boardId);
  const labels = await client.listLabels(remote.projectPath);
  const currentLabel = findLabel(labels, label);
  if (!currentLabel || currentLabel.id === undefined) {
    throw new OflowError(
      "Could not find a project label with a numeric ID for " + JSON.stringify(label) + ".",
      "LABEL_NOT_FOUND",
    );
  }
  const lists = await client.listBoardLists(remote.projectPath, boardId);
  if (lists.some((item) => item.label?.id === currentLabel.id)) {
    throw new OflowError(
      "Board " + String(boardId) + " already has a list for label " + JSON.stringify(currentLabel.name) + ".",
      "BOARD_LIST_EXISTS",
    );
  }
  return writePlan(root, {
    kind: "board-list.create",
    host: remote.host,
    projectPath: remote.projectPath,
    boardId,
    labelId: currentLabel.id,
    labelName: currentLabel.name,
  });
}

export async function createBoardListUpdatePlan(
  root: string,
  boardId: number,
  listId: number,
  position: number,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  validateBoardId(boardId);
  validateBoardListId(listId);
  validateBoardListPosition(position);
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  await client.getBoardList(remote.projectPath, boardId, listId);
  return writePlan(root, {
    kind: "board-list.update",
    host: remote.host,
    projectPath: remote.projectPath,
    boardId,
    listId,
    position,
  });
}

async function writePlan(root: string, operation: PlanOperation): Promise<StoredPlan> {
  const now = new Date().toISOString();
  const plan: PlanArtifact = {
    managedBy: "oflow",
    version: 2,
    id: randomUUID(),
    createdAt: now,
    sessionId: currentPlanSession(),
    expiresAt: new Date(Date.parse(now) + PLAN_TTL_MS).toISOString(),
    updatedAt: now,
    state: "draft",
    digest: "",
    operation,
  };
  plan.digest = planDigest(plan);
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeJson(path, plan);
  await recordPlanEvent(root, plan, "created");
  return { path, plan };
}

export async function approvePlan(root: string, input: string, options: { force?: boolean } = {}): Promise<StoredPlan> {
  const stored = await loadPlan(root, input);
  assertState(stored.plan, "draft", "approve");
  assertDigest(stored.plan);
  await assertPlanLifecycle(root, stored.plan, options.force);
  stored.plan.state = "approved";
  stored.plan.updatedAt = new Date().toISOString();
  await writeJson(stored.path, stored.plan);
  await recordPlanEvent(root, stored.plan, "approved");
  return stored;
}

export async function applyPlan(root: string, input: string, options: { force?: boolean } = {}): Promise<StoredPlan> {
  const stored = await loadPlan(root, input);
  assertState(stored.plan, ["approved", "applied-partial"], "apply");
  assertDigest(stored.plan);
  const wasResumed = stored.plan.state === "applied-partial";
  await assertPlanLifecycle(root, stored.plan, options.force);
  if ((DELEGATED_ONLY_OPERATIONS as readonly string[]).includes(stored.plan.operation.kind)) {
    throw new OflowError(
      stored.plan.operation.kind + " is delegated-only. Run: oflow apply <plan> --delegate, execute the returned action through the agent runtime's GitLab MCP tool, then oflow apply <plan> --receipt <file> and oflow verify <plan>.",
      "DELEGATED_ONLY_ACTION",
    );
  }

  const remote = await getGitLabRemote(root);
  if (
    remote.host !== stored.plan.operation.host ||
    remote.projectPath !== stored.plan.operation.projectPath
  ) {
    throw new OflowError(
      "The current Git remote does not match the plan target.",
      "PLAN_TARGET_MISMATCH",
    );
  }
  const client = new GitLabClient(remote.host);
  // F1 pre-apply preview + equivalent-state no-op detection, from a single
  // live read so the displayed diff and the no-op verdict agree.
  const snapshot = await loadApplySnapshot(stored.plan, client);
  if (snapshot.preview) {
    stored.plan.preview = snapshot.preview;
  }
  if (snapshot.equivalent.equivalent) {
    // The remote already matches the plan; record a verified no-op instead
    // of a misleading applied mutation.
    stored.plan.noOp = true;
    stored.plan.state = "verified";
    stored.plan.updatedAt = new Date().toISOString();
    stored.plan.verification = {
      passed: true,
      checks: snapshot.preview?.fields.map((field) => ({
        field: field.field,
        expected: field.after ?? "",
        actual: field.before ?? "",
        passed: (field.after ?? "") === (field.before ?? ""),
      })) ?? [],
      reasons: [
        "Equivalent state detected before apply: " +
          (snapshot.equivalent.reason ?? "remote state already matches the plan") +
          ". No mutation was issued.",
      ],
    };
    await writeJson(stored.path, stored.plan);
    await recordPlanEvent(root, stored.plan, "verified", undefined, {
      lifecycleReason: "no-op: equivalent state",
    });
    return stored;
  }
  if (stored.plan.operation.kind === "issue.create") {
    const result = await client.createIssue(
      stored.plan.operation.projectPath,
      stored.plan.operation.issue,
    );
    stored.plan.result = compactIssue(result, "issue.create");
  } else if (stored.plan.operation.kind === "issue.update") {
    const outcome = await executeIssueUpdate({
      root,
      host: stored.plan.operation.host,
      projectPath: stored.plan.operation.projectPath,
      issueIid: stored.plan.operation.issueIid,
      changes: stored.plan.operation.changes,
      expectedUpdatedAt: stored.plan.operation.expectedUpdatedAt,
      createRestClient: () => client,
    });
    stored.plan.result = compactIssue(outcome.issue);
    stored.plan.execution = { backend: outcome.backend };
  } else if (stored.plan.operation.kind === "issue.criterion.toggle") {
    const operation = stored.plan.operation;
    const outcome = await executeIssueUpdate({
      root,
      host: operation.host,
      projectPath: operation.projectPath,
      issueIid: operation.issueIid,
      changes: operation.changes,
      expectedUpdatedAt: operation.expectedUpdatedAt,
      createRestClient: () => client,
    });
    // Only after the description write lands, so the audit note never claims a
    // tick that failed. A duplicate note is not retried into a second copy.
    const note = await client.createIssueNote(
      operation.projectPath,
      operation.issueIid,
      { body: operation.note },
    );
    stored.plan.result = {
      kind: "issue.criterion.toggle",
      iid: operation.issueIid,
      criterion: operation.criterion,
      noteId: note.id,
    };
    stored.plan.execution = { backend: outcome.backend };
  } else if (stored.plan.operation.kind === "issue.iteration.update") {
    await assertIssueFresh(
      client,
      stored.plan.operation.projectPath,
      stored.plan.operation.issueIid,
      stored.plan.operation.expectedUpdatedAt,
    );
    const result = await client.setIssueIteration(
      stored.plan.operation.projectPath,
      stored.plan.operation.issueIid,
      stored.plan.operation.iterationId,
    );
    stored.plan.result = {
      kind: "issue.iteration.update",
      iid: result.iid,
      iterationId: stored.plan.operation.iterationId,
      iterationIid: stored.plan.operation.iterationIid,
      iterationTitle: stored.plan.operation.iterationTitle,
    };
  } else if (stored.plan.operation.kind === "issues.iteration.update") {
    const results = existingBulkResults(stored.plan, "issues.iteration.update");
    try {
      for (const issueIid of pendingBulkIssueIids(stored.plan.operation.issueIids, results)) {
        await assertIssueFresh(
          client,
          stored.plan.operation.projectPath,
          issueIid,
          stored.plan.operation.expectedUpdatedAt?.[String(issueIid)],
        );
        const result = await client.setIssueIteration(
          stored.plan.operation.projectPath,
          issueIid,
          stored.plan.operation.iterationId,
        );
        results.push(compactBulkIssueIterationIssue(
          { iid: result.iid },
          stored.plan.operation,
        ));
      }
    } catch (error: unknown) {
      await persistBulkApplyFailure(root, stored, "issues.iteration.update", results, error);
      throw error;
    }
    stored.plan.result = { kind: "issues.iteration.update", issues: results };
    delete stored.plan.applyError;
  } else if (stored.plan.operation.kind === "issues.labels.update") {
    const results = existingBulkResults(stored.plan, "issues.labels.update");
    try {
      for (const issueIid of pendingBulkIssueIids(stored.plan.operation.issueIids, results)) {
        await assertIssueFresh(
          client,
          stored.plan.operation.projectPath,
          issueIid,
          stored.plan.operation.expectedUpdatedAt?.[String(issueIid)],
        );
        const result = await client.updateIssue(
          stored.plan.operation.projectPath,
          issueIid,
          {
            add_labels: stored.plan.operation.add_labels,
            remove_labels: stored.plan.operation.remove_labels,
          },
        );
        results.push({ iid: result.iid, labels: result.labels ?? [] });
      }
    } catch (error: unknown) {
      await persistBulkApplyFailure(root, stored, "issues.labels.update", results, error);
      throw error;
    }
    stored.plan.result = { kind: "issues.labels.update", issues: results };
    delete stored.plan.applyError;
  } else if (stored.plan.operation.kind === "issues.planning.update") {
    const results = existingBulkResults(stored.plan, "issues.planning.update");
    try {
      for (const issueIid of pendingBulkIssueIids(stored.plan.operation.issueIids, results)) {
        await assertIssueFresh(
          client,
          stored.plan.operation.projectPath,
          issueIid,
          stored.plan.operation.expectedUpdatedAt?.[String(issueIid)],
        );
        const result = await client.updateIssue(
          stored.plan.operation.projectPath,
          issueIid,
          stored.plan.operation.changes,
        );
        results.push(compactBulkIssuePlanningIssue(result, stored.plan.operation.changes));
      }
    } catch (error: unknown) {
      await persistBulkApplyFailure(root, stored, "issues.planning.update", results, error);
      throw error;
    }
    stored.plan.result = { kind: "issues.planning.update", issues: results };
    delete stored.plan.applyError;
  } else if (stored.plan.operation.kind === "issue.note.create") {
    const operation = stored.plan.operation;
    const existing = (await client.getIssueNotes(
      operation.projectPath,
      operation.issueIid,
    )).find((note) => note.body === operation.body);
    const result = existing ?? await client.createIssueNote(
        operation.projectPath,
        operation.issueIid,
        { body: operation.body },
      );
    stored.plan.result = compactNote(
      result,
      operation.issueIid,
      existing !== undefined,
    );
  } else if (stored.plan.operation.kind === "issues.notes.create") {
    const operation = stored.plan.operation;
    const results = existingBulkResults(stored.plan, "issues.notes.create");
    try {
      for (const issueIid of pendingBulkIssueIids(operation.issueIids, results)) {
        await assertIssueFresh(
          client,
          operation.projectPath,
          issueIid,
          operation.expectedUpdatedAt?.[String(issueIid)],
        );
        const existing = (await client.getIssueNotes(
          operation.projectPath,
          issueIid,
        )).find((note) => note.body === operation.body);
        const note = existing ?? await client.createIssueNote(
          operation.projectPath,
          issueIid,
          { body: operation.body },
        );
        results.push({
          iid: issueIid,
          noteId: note.id,
          noteReused: existing !== undefined,
        });
      }
    } catch (error: unknown) {
      await persistBulkApplyFailure(root, stored, "issues.notes.create", results, error);
      throw error;
    }
    stored.plan.result = { kind: "issues.notes.create", issues: results };
    delete stored.plan.applyError;
  } else if (stored.plan.operation.kind === "label.create") {
    const operation = stored.plan.operation;
    const existing = findUniqueNamedResource(
      await client.listLabels(operation.projectPath),
      operation.name,
      (label) => label.name,
      "project label",
    );
    let reused = false;
    const result = existing === undefined
      ? await client.createLabel(
          operation.projectPath,
          {
            name: operation.name,
            color: operation.color,
            description: operation.description,
          },
        )
      : existing;
    if (existing !== undefined) {
      assertLabelCreateRecoveryMatch(existing, operation);
      reused = true;
    }
    stored.plan.result = compactLabel(result, "label.create", reused);
  } else if (stored.plan.operation.kind === "board.create") {
    const operation = stored.plan.operation;
    const existing = findUniqueNamedResource(
      await client.listBoards(operation.projectPath),
      operation.name,
      (board) => board.name,
      "project board",
    );
    const reused = existing !== undefined;
    const result = existing ?? await client.createBoard(
      operation.projectPath,
      { name: operation.name },
    );
    stored.plan.result = compactBoard(result, "board.create", reused);
  } else if (stored.plan.operation.kind === "board.update") {
    const result = await client.updateBoard(
      stored.plan.operation.projectPath,
      stored.plan.operation.boardId,
      stored.plan.operation.changes,
    );
    stored.plan.result = compactBoard(result, "board.update");
  } else if (stored.plan.operation.kind === "board-list.create") {
    const operation = stored.plan.operation;
    const lists = await client.listBoardLists(operation.projectPath, operation.boardId);
    const matchingLists = lists.filter((list) => list.label?.id === operation.labelId);
    if (matchingLists.length > 1) {
      throw new OflowError(
        "Board " + String(operation.boardId) + " has multiple lists for label #" +
          String(operation.labelId) + "; refusing ambiguous recovery.",
        "PLAN_RESOURCE_CONFLICT",
      );
    }
    const existing = matchingLists[0];
    const reused = existing !== undefined;
    const result = existing ?? await client.createBoardList(
      operation.projectPath,
      operation.boardId,
      { label_id: operation.labelId },
    );
    stored.plan.result = compactBoardList(result, "board-list.create", reused);
  } else if (stored.plan.operation.kind === "board-list.update") {
    const result = await client.updateBoardList(
      stored.plan.operation.projectPath,
      stored.plan.operation.boardId,
      stored.plan.operation.listId,
      { position: stored.plan.operation.position },
    );
    stored.plan.result = compactBoardList(result, "board-list.update");
  } else {
    if (stored.plan.operation.kind === "label.update") {
      const result = await client.updateLabel(
        stored.plan.operation.projectPath,
        stored.plan.operation.labelId ?? stored.plan.operation.label,
        stored.plan.operation.changes,
      );
      stored.plan.result = compactLabel(result, "label.update");
    } else if (stored.plan.operation.kind === "milestone.create") {
      const operation = stored.plan.operation;
      const existing = findUniqueNamedResource(
        await client.listMilestones(operation.projectPath, "all"),
        operation.title,
        (milestone) => milestone.title,
        "project milestone",
      );
      const reused = existing !== undefined;
      if (existing !== undefined) {
        assertMilestoneCreateRecoveryMatch(existing, operation);
      }
      const result = existing ?? await client.createMilestone(
        operation.projectPath,
        {
          title: operation.title,
          description: operation.description,
          start_date: operation.start_date,
          due_date: operation.due_date,
        },
      );
      stored.plan.result = compactMilestone(result, "milestone.create", reused);
    } else if (stored.plan.operation.kind === "milestone.update") {
      const result = await client.updateMilestone(
        stored.plan.operation.projectPath,
        stored.plan.operation.milestoneIid,
        stored.plan.operation.changes,
      );
      stored.plan.result = compactMilestone(result, "milestone.update");
    } else if (stored.plan.operation.kind === "merge_request.update") {
      const op = stored.plan.operation;
      const result = await client.updateMergeRequest(
        op.projectPath,
        op.iid,
        op.changes,
      );
      stored.plan.result = {
        kind: "merge_request.update",
        iid: result.iid,
        title: result.title,
        state: result.state ?? null,
      };
      stored.plan.execution = { backend: "rest" };
    }
  }
  stored.plan.state = "applied";
  stored.plan.applyError = undefined;
  stored.plan.updatedAt = new Date().toISOString();
  await writeJson(stored.path, stored.plan);
  await recordPlanEvent(root, stored.plan, wasResumed ? "resumed" : "applied");
  return stored;
}

export interface MergeRequestCreatePlanInput {
  root: string;
  storyIid: number;
  sourceBranch?: string;
  targetBranch?: string;
  title?: string;
  description?: string;
}

/**
 * Plan a delegated merge_request.create from live story context. The MR
 * description embeds the story linkage ("Closes #iid") so GitLab closes
 * the story on merge, mirroring the local template generator.
 */
export async function createMergeRequestCreatePlan(
  input: MergeRequestCreatePlanInput,
): Promise<StoredPlan> {
  const config = await loadConfig(input.root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  validateIssueIid(input.storyIid);
  const remote = await getGitLabRemote(input.root);
  const client = new GitLabClient(remote.host);
  const story = await client.getIssue(remote.projectPath, input.storyIid);
  const sourceBranch =
    input.sourceBranch ?? (await getCurrentBranch(input.root)) ?? undefined;
  if (!sourceBranch) {
    throw new OflowError(
      "No source branch detected. Check out the story branch or pass --source-branch.",
      "MISSING_SOURCE_BRANCH",
    );
  }
  const project = await client.getProject(remote.projectPath);
  const targetBranch = input.targetBranch ?? project.default_branch ?? "main";

  return writePlan(input.root, {
    kind: "merge_request.create",
    host: remote.host,
    projectPath: remote.projectPath,
    storyIid: input.storyIid,
    sourceBranch,
    targetBranch,
    title: input.title ?? story.title,
    description:
      input.description ??
      [
        "Implements story #" + input.storyIid + ": " + story.title,
        "",
        "## Acceptance criteria verification",
        "",
        "- [ ] AC-1: Add the story's acceptance criteria before opening this MR.",
        "  Evidence: TBD",
        "",
        "Closes #" + input.storyIid,
      ].join("\n"),
  });
}

export interface MergeRequestUpdatePlanInput {
  root: string;
  iid: number;
  title?: string;
  description?: string;
  stateEvent?: "close" | "reopen";
  targetBranch?: string;
}

/**
 * Plan a direct merge_request.update (F3). Reads the live MR once to capture
 * expectedUpdatedAt (for the --force recheck) and to reject updates that
 * would be no-ops with an explicit signal. The description may come from
 * --description-file; both paths preserve multiline text verbatim.
 */
export async function createMergeRequestUpdatePlan(
  input: MergeRequestUpdatePlanInput,
): Promise<StoredPlan> {
  const config = await loadConfig(input.root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  validateIssueIid(input.iid);
  const changes: MergeRequestUpdateOperation["changes"] = {};
  let fields = 0;
  if (input.title !== undefined) {
    changes.title = input.title;
    fields += 1;
  }
  if (input.description !== undefined) {
    changes.description = input.description;
    fields += 1;
  }
  if (input.stateEvent !== undefined) {
    changes.state_event = input.stateEvent;
    fields += 1;
  }
  if (input.targetBranch !== undefined) {
    changes.target_branch = input.targetBranch;
    fields += 1;
  }
  if (fields === 0) {
    throw new OflowError(
      "Nothing to update: pass --title, --description/--description-file, --state, or --target-branch.",
      "INVALID_PLAN_OPTION",
    );
  }
  const remote = await getGitLabRemote(input.root);
  const client = new GitLabClient(remote.host);
  const mr = await client.getMergeRequest(remote.projectPath, input.iid);
  return writePlan(input.root, {
    kind: "merge_request.update",
    host: remote.host,
    projectPath: remote.projectPath,
    iid: input.iid,
    expectedUpdatedAt: mr.updated_at ?? null,
    changes,
  });
}

export interface DelegatedApplyResult {
  stored: StoredPlan;
  descriptor: DelegatedActionRequest;
}

/**
 * Emit the delegated action descriptor for an approved delegated-only
 * plan. The agent runtime executes it through its GitLab MCP tool; oflow
 * then verifies the resulting GitLab state independently. The plan stays
 * in the approved state until verification succeeds.
 */
export async function applyPlanDelegated(
  root: string,
  input: string,
  options: { force?: boolean } = {},
): Promise<DelegatedApplyResult> {
  const stored = await loadPlan(root, input);
  assertState(stored.plan, "approved", "apply");
  assertDigest(stored.plan);
  await assertPlanLifecycle(root, stored.plan, options.force);
  const operation = stored.plan.operation;
  if (operation.kind !== "merge_request.create") {
    throw new OflowError(
      "Delegated apply currently supports merge_request.create plans only.",
      "UNSUPPORTED_DELEGATED_ACTION",
    );
  }
  const remote = await getGitLabRemote(root);
  if (remote.host !== operation.host || remote.projectPath !== operation.projectPath) {
    throw new OflowError(
      "The current Git remote does not match the plan target.",
      "PLAN_TARGET_MISMATCH",
    );
  }
  const descriptor: DelegatedActionRequest = {
    execution: "delegated",
    backendPreference: "gitlab-mcp",
    action: {
      name: "merge_request.create",
      arguments: {
        project: operation.projectPath,
        sourceBranch: operation.sourceBranch,
        targetBranch: operation.targetBranch,
        title: operation.title,
        description: operation.description,
      },
    },
    afterExecution: {
      command: "oflow apply " + relative(root, stored.path) + " --receipt <receipt.json>",
    },
  };
  await recordPlanEvent(root, stored.plan, "delegated");
  return { stored, descriptor };
}

/**
 * Ingest the execution receipt produced by the agent runtime after it ran
 * the delegated action through its GitLab MCP tool. A successful receipt
 * transitions the plan to `applied` so independent verification can run;
 * a failed receipt records the failure without contacting GitLab.
 */
export async function ingestExecutionReceipt(
  root: string,
  input: string,
  receipt: ExecutionReceipt,
  options: { force?: boolean } = {},
): Promise<StoredPlan> {
  const stored = await loadPlan(root, input);
  assertState(stored.plan, "approved", "apply a receipt to");
  assertDigest(stored.plan);
  // Receipts reconcile execution evidence, even after expiry or a session change.
  const operation = stored.plan.operation;
  if (operation.kind !== "merge_request.create") {
    throw new OflowError(
      "Delegated apply currently supports merge_request.create plans only.",
      "UNSUPPORTED_DELEGATED_ACTION",
    );
  }
  if (receipt.backend !== "gitlab-mcp") {
    throw new OflowError(
      "Delegated receipts must come from the gitlab-mcp backend; got " + receipt.backend + ".",
      "INVALID_RECEIPT_BACKEND",
    );
  }
  if (receipt.action !== operation.kind) {
    throw new OflowError(
      "Receipt action " + receipt.action + " does not match plan operation " + operation.kind + ".",
      "RECEIPT_ACTION_MISMATCH",
    );
  }
  const receiptResult = receipt.result && typeof receipt.result === "object"
    ? receipt.result as Record<string, unknown>
    : {};
  const resultIid = typeof receiptResult.iid === "number" ? receiptResult.iid
    : typeof receiptResult.id === "number" ? receiptResult.id
    : undefined;
  const resultUrl = typeof receiptResult.web_url === "string" ? receiptResult.web_url
    : typeof receiptResult.webUrl === "string" ? receiptResult.webUrl
    : undefined;
  stored.plan.delegatedReceipt = {
    backend: receipt.backend,
    action: receipt.action,
    executedAt: receipt.executedAt,
    resultIid,
    resultUrl,
    error: receipt.error,
  };
  if (!receipt.success) {
    const failure = {
      code: "DELEGATED_EXECUTION_FAILED",
      message: receipt.error ?? "The agent runtime reported a failed delegated execution.",
    };
    stored.plan.applyError = { ...failure, completed: 0 };
    stored.plan.updatedAt = new Date().toISOString();
    await writeJson(stored.path, stored.plan);
    await recordPlanEvent(root, stored.plan, "apply-failed", failure);
    throw new OflowError(failure.message, failure.code);
  }
  stored.plan.applyError = undefined;
  stored.plan.execution = { backend: "gitlab-mcp" };
  stored.plan.result = {
    kind: operation.kind,
    iid: resultIid,
    webUrl: resultUrl,
  };
  stored.plan.state = "applied";
  stored.plan.updatedAt = new Date().toISOString();
  await writeJson(stored.path, stored.plan);
  await recordPlanEvent(root, stored.plan, "receipt");
  return stored;
}

export async function verifyPlan(root: string, input: string): Promise<StoredPlan> {
  const stored = await loadPlan(root, input);
  if (stored.plan.state !== "applied" && stored.plan.state !== "verified") {
    throw new OflowError(
      "Only an applied plan can be verified.",
      "INVALID_PLAN_STATE",
    );
  }
  assertDigest(stored.plan);

  const remote = await getGitLabRemote(root);
  if (
    remote.host !== stored.plan.operation.host ||
    remote.projectPath !== stored.plan.operation.projectPath
  ) {
    throw new OflowError(
      "The current Git remote does not match the plan target.",
      "PLAN_TARGET_MISMATCH",
    );
  }
  const client = new GitLabClient(remote.host);
  const verification = stored.plan.operation.kind === "issue.create"
    ? verifyIssue(
        await client.getIssue(
          stored.plan.operation.projectPath,
          resultIssueIid(stored.plan.result?.iid),
        ),
        stored.plan.operation.issue,
      )
    : stored.plan.operation.kind === "issue.update"
    ? verifyIssue(
        await client.getIssue(
          stored.plan.operation.projectPath,
          stored.plan.operation.issueIid,
        ),
        stored.plan.operation.changes,
      )
    : stored.plan.operation.kind === "issue.criterion.toggle"
    ? verifyCriterionToggle(
        await client.getIssue(
          stored.plan.operation.projectPath,
          stored.plan.operation.issueIid,
        ),
        await client.getIssueNotes(
          stored.plan.operation.projectPath,
          stored.plan.operation.issueIid,
        ),
        stored.plan.operation,
      )
    : stored.plan.operation.kind === "issue.iteration.update"
    ? verifyIssueIteration(
        await client.getIssue(
          stored.plan.operation.projectPath,
          stored.plan.operation.issueIid,
        ),
        stored.plan.operation,
      )
    : stored.plan.operation.kind === "issues.iteration.update"
      ? verifyBulkIssueIteration(
          await Promise.all(
            stored.plan.operation.issueIids.map((issueIid) =>
              client.getIssue(stored.plan.operation.projectPath, issueIid)),
          ),
          stored.plan.operation,
        )
    : stored.plan.operation.kind === "issues.labels.update"
      ? verifyBulkIssueLabels(
          await Promise.all(
            stored.plan.operation.issueIids.map((issueIid) =>
              client.getIssue(stored.plan.operation.projectPath, issueIid)),
          ),
          stored.plan.operation,
        )
    : stored.plan.operation.kind === "issues.planning.update"
      ? verifyBulkIssuePlanning(
          await Promise.all(
            stored.plan.operation.issueIids.map((issueIid) =>
              client.getIssue(stored.plan.operation.projectPath, issueIid)),
          ),
          stored.plan.operation,
        )
      : stored.plan.operation.kind === "issue.note.create"
      ? verifyIssueNote(
          await client.getIssueNotes(
            stored.plan.operation.projectPath,
            stored.plan.operation.issueIid,
          ),
          stored.plan.operation.body,
          stored.plan.result?.noteId,
        )
      : stored.plan.operation.kind === "issues.notes.create"
      ? await verifyBulkIssueNotes(client, stored)
      : stored.plan.operation.kind === "merge_request.create"
        ? await verifyMergeRequestCreate(client, stored.plan.operation)
      : stored.plan.operation.kind === "label.create" || stored.plan.operation.kind === "label.update"
        ? verifyLabel(
          await client.listLabels(stored.plan.operation.projectPath),
          stored.plan.operation,
          stored.plan.result?.labelId,
        )
        : stored.plan.operation.kind === "milestone.create" || stored.plan.operation.kind === "milestone.update"
        ? verifyMilestone(
            await client.getMilestone(
              stored.plan.operation.projectPath,
              stored.plan.operation.kind === "milestone.create"
                ? resultMilestoneIid(stored.plan.result?.milestoneIid)
                : stored.plan.operation.milestoneIid,
            ),
            stored.plan.operation,
          )
        : stored.plan.operation.kind === "board.create" || stored.plan.operation.kind === "board.update"
          ? verifyBoard(
              await client.getBoard(
                stored.plan.operation.projectPath,
                stored.plan.operation.kind === "board.create"
                  ? resultBoardId(stored.plan.result?.boardId)
                  : stored.plan.operation.boardId,
              ),
              stored.plan.operation,
            )
          : stored.plan.operation.kind === "merge_request.update"
            ? verifyMergeRequestUpdate(
                await client.getMergeRequest(
                  stored.plan.operation.projectPath,
                  stored.plan.operation.iid,
                ),
                stored.plan.operation,
              )
            : verifyBoardList(
                await client.getBoardList(
                  stored.plan.operation.projectPath,
                  stored.plan.operation.boardId,
                  stored.plan.operation.kind === "board-list.create"
                    ? resultListId(stored.plan.result?.listId)
                    : stored.plan.operation.listId,
                ),
                stored.plan.operation,
              );
  stored.plan.verification = verification;
  if (verification.passed) {
    stored.plan.state = "verified";
  }
  stored.plan.updatedAt = new Date().toISOString();
  await writeJson(stored.path, stored.plan);
  await recordPlanEvent(root, stored.plan, "verified");
  return stored;
}

export function formatPlanMarkdown(stored: StoredPlan): string {
  const { plan } = stored;
  const operationSummary = plan.operation.kind === "issue.create"
    ? Object.entries(plan.operation.issue)
        .map(([key, value]) => "- " + key + ": " + String(value))
        .join("\n")
    : plan.operation.kind === "issue.update"
      ? Object.entries(plan.operation.changes)
        .map(([key, value]) => "- " + key + ": " + String(value))
        .join("\n")
      : plan.operation.kind === "issue.iteration.update"
        ? [
            "- issue_iid: " + plan.operation.issueIid,
            "- iteration: " + (plan.operation.iterationTitle ?? "none") +
              (plan.operation.iterationIid === null ? "" : " (#" + plan.operation.iterationIid + ")"),
          ].join("\n")
      : plan.operation.kind === "issues.iteration.update"
        ? [
            "- issue_iids: " + plan.operation.issueIids.join(", "),
            "- iteration: " + (plan.operation.iterationTitle ?? "none") +
              (plan.operation.iterationIid === null ? "" : " (#" + plan.operation.iterationIid + ")"),
          ].join("\n")
      : plan.operation.kind === "issues.labels.update"
        ? [
            "- issue_iids: " + plan.operation.issueIids.join(", "),
            ...(plan.operation.add_labels === undefined
              ? []
              : ["- add_labels: " + plan.operation.add_labels]),
            ...(plan.operation.remove_labels === undefined
              ? []
              : ["- remove_labels: " + plan.operation.remove_labels]),
          ].join("\n")
      : plan.operation.kind === "issues.planning.update"
        ? [
            "- issue_iids: " + plan.operation.issueIids.join(", "),
            ...Object.entries(plan.operation.changes)
              .map(([key, value]) => "- " + key + ": " + String(value)),
          ].join("\n")
      : plan.operation.kind === "issue.note.create"
        ? "- body: " + plan.operation.body
        : plan.operation.kind === "issues.notes.create"
        ? [
            "- issue_iids: " + plan.operation.issueIids.join(", "),
            "- body: " + plan.operation.body,
          ].join("\n")
        : plan.operation.kind === "merge_request.create"
          ? [
              "- story_iid: " + plan.operation.storyIid,
              "- source_branch: " + plan.operation.sourceBranch,
              "- target_branch: " + plan.operation.targetBranch,
              "- title: " + plan.operation.title,
            ].join("\n")
        : plan.operation.kind === "label.create"
        ? [
            "- name: " + plan.operation.name,
            "- color: " + plan.operation.color,
            ...(plan.operation.description === undefined
              ? []
              : ["- description: " + plan.operation.description]),
          ].join("\n")
        : plan.operation.kind === "label.update"
          ? Object.entries(plan.operation.changes)
              .map(([key, value]) => "- " + key + ": " + String(value))
              .join("\n")
          : plan.operation.kind === "milestone.create"
            ? [
                "- title: " + plan.operation.title,
                ...(plan.operation.description === undefined
                  ? []
                  : ["- description: " + plan.operation.description]),
                ...(plan.operation.start_date === undefined
                  ? []
                  : ["- start_date: " + plan.operation.start_date]),
                ...(plan.operation.due_date === undefined
                  ? []
                  : ["- due_date: " + plan.operation.due_date]),
              ].join("\n")
                : plan.operation.kind === "milestone.update"
                  ? Object.entries(plan.operation.changes)
                    .map(([key, value]) => "- " + key + ": " + String(value))
                    .join("\n")
                  : plan.operation.kind === "board.create"
                    ? "- name: " + plan.operation.name
                    : plan.operation.kind === "board.update"
                      ? Object.entries(plan.operation.changes)
                          .map(([key, value]) => "- " + key + ": " + String(value))
                          .join("\n")
                      : plan.operation.kind === "board-list.create"
                        ? [
                            "- board_id: " + plan.operation.boardId,
                            "- label_id: " + plan.operation.labelId,
                            "- label: " + plan.operation.labelName,
                          ].join("\n")
                        : plan.operation.kind === "issue.criterion.toggle"
                          ? [
                              "- criterion: " + plan.operation.criterion.id +
                                (plan.operation.criterion.checked ? " (checked)" : " (unchecked)"),
                              "- note: " + plan.operation.note,
                            ].join("\n")
                        : plan.operation.kind === "merge_request.update"
                          ? Object.entries(plan.operation.changes)
                              .map(([key, value]) => "- " + key + ": " + String(value))
                              .join("\n")
                          : [
                              "- board_id: " + plan.operation.boardId,
                              "- list_id: " + plan.operation.listId,
                              "- position: " + plan.operation.position,
                            ].join("\n");
  const lines = [
    "# oflow plan",
    "",
    "Plan: " + stored.path,
    "ID: " + plan.id,
    "State: " + plan.state,
    "Session: " + (plan.sessionId ?? "legacy (unknown)"),
    "Expires: " + (plan.expiresAt ?? "legacy (unknown)"),
    "Target: " + plan.operation.host + "/" + plan.operation.projectPath + " " + formatTarget(plan.operation),
    "Digest: " + plan.digest,
    ...(plan.sourceAssessment
      ? [
        "Source assessment: " + plan.sourceAssessment.status +
          " at " + plan.sourceAssessment.generatedAt,
        "Assessment recommendations: " +
          (plan.sourceAssessment.recommendations.length > 0
            ? plan.sourceAssessment.recommendations.join(" | ")
            : "none"),
      ]
      : []),
    "",
    plan.operation.kind === "issue.create"
      ? "Create " + (plan.operation.issue.issue_type ?? "issue") + ":"
      : plan.operation.kind === "issue.update"
      ? "Changes:"
      : plan.operation.kind === "issue.criterion.toggle"
        ? "Toggle acceptance criterion:"
      : plan.operation.kind === "issue.iteration.update"
      ? "Iteration change:"
      : plan.operation.kind === "issues.iteration.update"
        ? "Bulk iteration changes:"
      : plan.operation.kind === "issues.labels.update"
        ? "Bulk label changes:"
      : plan.operation.kind === "issues.planning.update"
        ? "Bulk planning changes:"
      : plan.operation.kind === "issue.note.create"
        ? "Note:"
        : plan.operation.kind === "issues.notes.create"
        ? "Bulk note changes:"
        : plan.operation.kind === "label.create"
          ? "Create label:"
          : plan.operation.kind === "label.update"
            ? "Update label:"
            : plan.operation.kind === "milestone.create"
            ? "Create milestone:"
              : plan.operation.kind === "milestone.update"
                ? "Update milestone:"
                : plan.operation.kind === "board.create"
                  ? "Create board:"
                  : plan.operation.kind === "board.update"
                    ? "Update board:"
                    : plan.operation.kind === "board-list.create"
                      ? "Create board list:"
                      : "Update board list:",
    operationSummary,
  ];
  if (plan.preview) {
    lines.push("", formatApplyPreviewMarkdown(plan.preview));
  }
  if (plan.noOp) {
    lines.push("", "NO-OP: equivalent remote state detected before the mutation; no write was issued.");
  }
  if (plan.result) {
    lines.push("", "Applied result: " + formatResult(plan.result));
  }
  if (plan.applyError) {
    lines.push(
      "",
      "APPLY INCOMPLETE: " + plan.applyError.code + " — " + plan.applyError.message,
      "Completed targets: " + String(plan.applyError.completed),
      "",
      "Retry the approved bulk plan only after reviewing the partial result.",
    );
  }
  if (plan.verification) {
    lines.push(
      "",
      plan.verification.passed ? "VERIFIED" : "NOT VERIFIED",
      ...plan.verification.checks.map(
        (check) =>
          "- " +
          (check.passed ? "PASS" : "FAIL") +
          " " +
          check.field +
          ": expected " +
          check.expected +
          ", got " +
          check.actual,
      ),
      ...plan.verification.reasons.map((reason) => "- " + reason),
      ...(plan.execution?.backend === "gitlab-mcp"
        ? [
            "- Transport split: the agent runtime executed this action through GitLab MCP; oflow verified the resulting remote state independently through its own REST read transport.",
          ]
        : []),
    );
  }
  lines.push("");
  return lines.join("\n");
}

// Unset sessions are TTL-only. Old shell-PID artifacts are also implicit: PIDs
// are neither stable shell identities nor evidence of a different agent session.
function currentPlanSession(): string | undefined {
  return process.env.OFLOW_SESSION_ID?.trim() || undefined;
}

function lifecycleIssue(plan: PlanArtifact): string | null {
  const created = Date.parse(plan.createdAt);
  if (!Number.isFinite(created) || new Date(created).toISOString() !== plan.createdAt || created > Date.now()) {
    throw new OflowError("Invalid plan creation timestamp.", "INVALID_PLAN");
  }
  if (plan.sessionId === undefined && plan.expiresAt === undefined) return "legacy";
  if (
    (plan.sessionId !== undefined && (typeof plan.sessionId !== "string" || !plan.sessionId.trim())) ||
    typeof plan.expiresAt !== "string" || !Number.isFinite(Date.parse(plan.expiresAt)) ||
    new Date(Date.parse(plan.expiresAt)).toISOString() !== plan.expiresAt ||
    Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt) ||
    Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) > PLAN_TTL_MS
  ) {
    throw new OflowError("Invalid plan lifecycle metadata.", "INVALID_PLAN");
  }
  if (Date.now() >= Date.parse(plan.expiresAt)) return "expired";
  const current = currentPlanSession();
  if (current && plan.sessionId && !/^shell-\d+$/.test(plan.sessionId) && plan.sessionId !== current) return "cross-session";
  return null;
}

async function assertPlanLifecycle(root: string, plan: PlanArtifact, force = false): Promise<void> {
  const reason = lifecycleIssue(plan);
  if (!reason) return;
  if (!force) {
    throw new OflowError(
      "Refusing " + reason + " plan. Create a fresh plan, or explicitly use --force after reviewing the target.",
      "PLAN_LIFECYCLE_BLOCKED",
    );
  }
  // Force overrides only lifecycle freshness, never target, digest or state checks.
  const remote = await getGitLabRemote(root);
  if (remote.host !== plan.operation.host || remote.projectPath !== plan.operation.projectPath) {
    throw new OflowError("The current Git remote does not match the plan target.", "PLAN_TARGET_MISMATCH");
  }
  const rechecks = await recheckPlanTarget(plan);
  await recordPlanEvent(root, plan, "lifecycle-forced", undefined, {
    lifecycleReason: reason, recheckedAt: new Date().toISOString(), rechecks,
  });
}

/** Read-only revalidation of the operation's target and recorded preconditions. */
async function recheckPlanTarget(plan: PlanArtifact): Promise<string[]> {
  const op = plan.operation;
  const client = new GitLabClient(op.host);
  const project = await client.getProject(op.projectPath);
  const requireTarget = (valid: boolean): void => {
    if (!valid) throw new OflowError(
      "Live plan target cannot be proven or has changed; create a fresh plan.",
      "PLAN_TARGET_CHANGED",
    );
  };
  requireTarget(project.path_with_namespace === op.projectPath);
  const checks = ["project-identity"];
  const issue = async (iid: number, expected?: string | null) => {
    const current = await client.getIssue(op.projectPath, iid);
    requireTarget(current.iid === iid);
    if (expected !== undefined) requireTarget((current.updated_at ?? null) === expected);
    checks.push("issue-identity:" + iid, ...(expected === undefined ? [] : ["issue-updated-at:" + iid]));
  };
  switch (op.kind) {
    case "issue.create":
      break;
    case "issue.update":
    case "issue.criterion.toggle":
    case "issue.iteration.update":
      // Without a captured revision, a stale update cannot prove absence of drift.
      requireTarget(op.expectedUpdatedAt !== undefined);
      await issue(op.issueIid, op.expectedUpdatedAt);
      break;
    case "issues.labels.update":
    case "issues.planning.update":
    case "issues.iteration.update":
    case "issues.notes.create":
      for (const iid of pendingBulkIssueIids(op.issueIids, existingBulkResults(plan, op.kind))) {
        requireTarget(op.expectedUpdatedAt?.[String(iid)] !== undefined);
        await issue(iid, op.expectedUpdatedAt?.[String(iid)]);
      }
      break;
    case "issue.note.create":
      await issue(op.issueIid);
      break;
    case "merge_request.create":
      await issue(op.storyIid);
      // The current provider has no branch/head read boundary. Do not emit a
      // stale delegated action when its branch targets cannot be proven live.
      throw new OflowError(
        "Cannot recheck merge-request branch targets with the current provider; create a fresh plan.",
        "PLAN_RECHECK_UNSUPPORTED",
      );
    case "merge_request.update": {
      // Without captured revision metadata a stale forced apply cannot prove
      // the MR did not drift; with it, prove the MR is unchanged live.
      requireTarget(op.expectedUpdatedAt !== undefined && op.expectedUpdatedAt !== null);
      const mr = await client.getMergeRequest(op.projectPath, op.iid);
      requireTarget(mr.iid === op.iid);
      requireTarget((mr.updated_at ?? null) === (op.expectedUpdatedAt ?? null));
      checks.push("merge-request-identity:" + String(op.iid), "merge-request-updated-at:" + String(op.iid));
      break;
    }
    case "label.create": {
      const page = await client.listLabelsPage(op.projectPath);
      requireTarget(!page.pagination.hasNextPage);
      const existing = findUniqueNamedResource(page.items, op.name, (item) => item.name, "project label");
      if (existing) assertLabelCreateRecoveryMatch(existing, op);
      checks.push("label-create-preconditions");
      break;
    }
    case "milestone.create": {
      const page = await client.listMilestonesPage(op.projectPath, "all");
      requireTarget(!page.pagination.hasNextPage);
      const existing = findUniqueNamedResource(page.items, op.title, (item) => item.title, "project milestone");
      if (existing) assertMilestoneCreateRecoveryMatch(existing, op);
      checks.push("milestone-create-preconditions");
      break;
    }
    case "board.create": {
      const page = await client.listBoardsPage(op.projectPath);
      requireTarget(!page.pagination.hasNextPage);
      findUniqueNamedResource(page.items, op.name, (item) => item.name, "project board");
      checks.push("board-create-preconditions");
      break;
    }
    case "board-list.create": {
      requireTarget((await client.getBoard(op.projectPath, op.boardId)).id === op.boardId);
      const labels = await client.listLabelsPage(op.projectPath);
      requireTarget(!labels.pagination.hasNextPage && labels.items.some(
        (label) => label.id === op.labelId && label.name === op.labelName,
      ));
      const lists = await client.listBoardListsPage(op.projectPath, op.boardId);
      requireTarget(!lists.pagination.hasNextPage && lists.items.filter((list) => list.label?.id === op.labelId).length <= 1);
      checks.push("board-identity", "label-identity", "board-list-create-preconditions");
      break;
    }
    case "label.update":
    case "milestone.update":
    case "board.update":
    case "board-list.update":
      // These artifacts do not yet capture a remote revision or before-image.
      // An existence check would not establish that a stale update is safe.
      throw new OflowError(
        "This update has no recorded remote revision; create a fresh plan instead of forcing it.",
        "PLAN_RECHECK_UNSUPPORTED",
      );
  }
  if ((op.kind === "issue.iteration.update" || op.kind === "issues.iteration.update") && op.iterationId !== null) {
    const page = await client.listProjectIterationsPage(op.projectPath);
    requireTarget(!page.pagination.hasNextPage && page.items.some((iteration) =>
      "gid://gitlab/Iteration/" + iteration.id === op.iterationId && iteration.iid === op.iterationIid && iteration.title === op.iterationTitle,
    ));
    checks.push("iteration-identity");
  }
  return checks;
}

export async function listPlans(root: string) {
  let entries;
  try {
    entries = await readdir(join(root, PLAN_DIRECTORY), { withFileTypes: true });
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const plans = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
    const { path, plan } = await loadPlan(root, join(PLAN_DIRECTORY, entry.name));
    assertDigest(plan);
    if (!["draft", "approved", "applied", "applied-partial", "verified"].includes(plan.state)) {
      throw new OflowError("Invalid plan state.", "INVALID_PLAN");
    }
    plans.push({
      id: plan.id, path, state: plan.state, createdAt: plan.createdAt,
      ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(plan.createdAt)) / 1000)),
      sessionId: plan.sessionId ?? null, expiresAt: plan.expiresAt ?? null,
      lifecycle: lifecycleIssue(plan) ?? "current",
      operation: plan.operation.kind,
      target: plan.operation.host + "/" + plan.operation.projectPath + " " + formatTarget(plan.operation),
    });
    } catch (error: unknown) {
      plans.push({
        id: entry.name.slice(0, -5), path: join(root, PLAN_DIRECTORY, entry.name),
        state: "invalid", createdAt: null, ageSeconds: null, sessionId: null,
        expiresAt: null, lifecycle: "invalid", operation: "unknown", target: "unknown",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return plans;
}

export async function discardPlan(root: string, id: string): Promise<{ id: string; discarded: true }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    throw new OflowError("Discard requires a local plan ID, not a path.", "UNSAFE_PLAN_PATH");
  }
  const input = join(PLAN_DIRECTORY, id + ".json");
  const path = resolvePlanPath(root, input);
  if (
    await realpath(join(root, PLAN_DIRECTORY)) !== join(await realpath(root), PLAN_DIRECTORY) ||
    !(await lstat(path)).isFile()
  ) {
    throw new OflowError("Discard requires a regular local plan file.", "UNSAFE_PLAN_PATH");
  }
  const { plan } = await loadPlan(root, input);
  const audit = await readAudit(root, Number.MAX_SAFE_INTEGER);
  if (
    plan.id !== id || (plan.state !== "draft" && plan.state !== "approved") ||
    plan.result || plan.execution || plan.delegatedReceipt || plan.applyError ||
    audit.events.some((event) => event.planId === id &&
      ["delegated", "receipt", "applied", "apply-failed", "verified"].includes(event.action))
  ) {
    throw new OflowError("Cannot discard terminal plans or plans with execution history.", "PLAN_HISTORY_PROTECTED");
  }
  await unlink(path);
  await recordPlanEvent(root, plan, "discarded");
  return { id, discarded: true };
}

async function loadPlan(root: string, input: string): Promise<StoredPlan> {
  const path = resolvePlanPath(root, input);
  const plan = await readJson<PlanArtifact>(path);
  if (!plan || plan.managedBy !== "oflow" || plan.version !== 2) {
    throw new OflowError("Invalid oflow plan artifact: " + path, "INVALID_PLAN");
  }
  if (!isSupportedOperation(plan.operation)) {
    throw new OflowError("Unsupported oflow plan operation.", "UNSUPPORTED_PLAN");
  }
  return { path, plan };
}

/** Public read-only plan loader for CLI preconditions (e.g. --yes). */
export async function loadPlanArtifact(root: string, input: string): Promise<StoredPlan> {
  return loadPlan(root, input);
}

function isSupportedOperation(
  operation: PlanArtifact["operation"] | undefined,
): operation is PlanOperation {
  if (!operation || typeof operation !== "object") {
    return false;
  }
  if (
    typeof operation.host !== "string" ||
    typeof operation.projectPath !== "string"
  ) {
    return false;
  }
  if (operation.kind === "issue.create") {
    return validIssueCreateOperation(operation);
  }
  if (operation.kind === "issue.update") {
    return validIssueOperation(operation) &&
      Boolean(operation.changes && typeof operation.changes === "object") &&
      (operation.changes.issue_type === undefined || isIssueType(operation.changes.issue_type)) &&
      validExpectedUpdatedAt(operation.expectedUpdatedAt);
  }
  if (operation.kind === "issue.criterion.toggle") {
    return validIssueOperation(operation) &&
      Boolean(operation.changes && typeof operation.changes === "object") &&
      typeof operation.changes.description === "string" &&
      operation.changes.description.trim().length > 0 &&
      Boolean(operation.criterion) &&
      typeof operation.criterion.id === "string" &&
      /^AC-\d+$/.test(operation.criterion.id) &&
      typeof operation.criterion.checked === "boolean" &&
      typeof operation.note === "string" &&
      operation.note.trim().length > 0 &&
      validExpectedUpdatedAt(operation.expectedUpdatedAt);
  }
  if (operation.kind === "issue.iteration.update") {
    return validIssueIterationOperation(operation);
  }
  if (operation.kind === "issues.labels.update") {
    const addLabelsValid = operation.add_labels === undefined ||
      (typeof operation.add_labels === "string" && operation.add_labels.trim().length > 0);
    const removeLabelsValid = operation.remove_labels === undefined ||
      (typeof operation.remove_labels === "string" && operation.remove_labels.trim().length > 0);
    return Array.isArray(operation.issueIids) &&
      operation.issueIids.length > 0 &&
      operation.issueIids.length <= MAX_BULK_ISSUES &&
      new Set(operation.issueIids).size === operation.issueIids.length &&
      operation.issueIids.every((issueIid) => Number.isSafeInteger(issueIid) && issueIid > 0) &&
      (operation.add_labels !== undefined || operation.remove_labels !== undefined) &&
      addLabelsValid &&
      removeLabelsValid &&
      validExpectedUpdatedAtMap(operation.expectedUpdatedAt);
  }
  if (operation.kind === "issues.planning.update") {
    return Array.isArray(operation.issueIids) &&
      operation.issueIids.length > 0 &&
      operation.issueIids.length <= MAX_BULK_ISSUES &&
      new Set(operation.issueIids).size === operation.issueIids.length &&
      operation.issueIids.every((issueIid) => Number.isSafeInteger(issueIid) && issueIid > 0) &&
      Boolean(operation.changes && typeof operation.changes === "object") &&
      Object.keys(operation.changes).length > 0 &&
      Object.keys(operation.changes).every((key) =>
        key === "milestone" || key === "milestone_id" || key === "assignee_ids"
      ) &&
      validExpectedUpdatedAtMap(operation.expectedUpdatedAt);
  }
  if (operation.kind === "issues.iteration.update") {
    return Array.isArray(operation.issueIids) &&
      operation.issueIids.length > 0 &&
      operation.issueIids.length <= MAX_BULK_ISSUES &&
      new Set(operation.issueIids).size === operation.issueIids.length &&
      operation.issueIids.every((issueIid) => Number.isSafeInteger(issueIid) && issueIid > 0) &&
      (operation.iterationId === null ||
        (typeof operation.iterationId === "string" &&
          /^gid:\/\/gitlab\/Iteration\/\d+$/.test(operation.iterationId))) &&
      (operation.iterationId === null
        ? operation.iterationIid === null && operation.iterationTitle === null
        : typeof operation.iterationIid === "number" && Number.isSafeInteger(operation.iterationIid) && operation.iterationIid > 0 &&
          typeof operation.iterationTitle === "string" && operation.iterationTitle.trim().length > 0) &&
      validExpectedUpdatedAtMap(operation.expectedUpdatedAt);
  }
  if (operation.kind === "issue.note.create") {
    return validIssueOperation(operation) &&
      typeof operation.body === "string" &&
      operation.body.trim().length > 0;
  }
  if (operation.kind === "issues.notes.create") {
    return Array.isArray(operation.issueIids) &&
      operation.issueIids.length > 0 &&
      operation.issueIids.length <= MAX_BULK_ISSUES &&
      new Set(operation.issueIids).size === operation.issueIids.length &&
      operation.issueIids.every((issueIid) => Number.isSafeInteger(issueIid) && issueIid > 0) &&
      typeof operation.body === "string" &&
      operation.body.trim().length > 0 &&
      validExpectedUpdatedAtMap(operation.expectedUpdatedAt);
  }
  if (operation.kind === "label.create") {
    return typeof operation.name === "string" &&
      typeof operation.color === "string" &&
      operation.name.trim().length > 0 &&
      operation.color.trim().length > 0;
  }
  if (operation.kind === "label.update") {
    return typeof operation.label === "string" &&
      operation.label.trim().length > 0 &&
      Boolean(operation.changes && typeof operation.changes === "object") &&
      Object.keys(operation.changes).length > 0;
  }
  if (operation.kind === "milestone.create") {
    return typeof operation.title === "string" &&
      operation.title.trim().length > 0 &&
      isDateString(operation.start_date) &&
      isDateString(operation.due_date);
  }
  if (operation.kind === "milestone.update") {
    return Number.isSafeInteger(operation.milestoneIid) &&
      operation.milestoneIid > 0 &&
      Boolean(operation.changes && typeof operation.changes === "object") &&
      Object.keys(operation.changes).length > 0;
  }
  if (operation.kind === "board.create") {
    return typeof operation.name === "string" && operation.name.trim().length > 0;
  }
  if (operation.kind === "board.update") {
    return Number.isSafeInteger(operation.boardId) && operation.boardId > 0 &&
      Boolean(operation.changes && typeof operation.changes === "object") &&
      Object.keys(operation.changes).length > 0;
  }
  if (operation.kind === "board-list.create") {
    return Number.isSafeInteger(operation.boardId) && operation.boardId > 0 &&
      Number.isSafeInteger(operation.labelId) && operation.labelId > 0 &&
      typeof operation.labelName === "string" && operation.labelName.trim().length > 0;
  }
  if (operation.kind === "merge_request.create") {
    return Number.isSafeInteger(operation.storyIid) && operation.storyIid > 0 &&
      typeof operation.sourceBranch === "string" && operation.sourceBranch.trim().length > 0 &&
      typeof operation.targetBranch === "string" && operation.targetBranch.trim().length > 0 &&
      typeof operation.title === "string" && operation.title.trim().length > 0 &&
      typeof operation.description === "string";
  }
  if (operation.kind === "merge_request.update") {
    return Number.isSafeInteger(operation.iid) && operation.iid > 0 &&
      Boolean(operation.changes && typeof operation.changes === "object") &&
      Object.keys(operation.changes).length > 0 &&
      Object.keys(operation.changes).every((key) =>
        key === "title" || key === "description" ||
        key === "state_event" || key === "target_branch") &&
      (operation.changes.state_event === undefined ||
        operation.changes.state_event === "close" ||
        operation.changes.state_event === "reopen") &&
      validExpectedUpdatedAt(operation.expectedUpdatedAt);
  }
  return operation.kind === "board-list.update" &&
    Number.isSafeInteger(operation.boardId) && operation.boardId > 0 &&
    Number.isSafeInteger(operation.listId) && operation.listId > 0 &&
    Number.isSafeInteger(operation.position) && operation.position >= 0;
}

function validIssueOperation(
  operation: PlanOperation,
): operation is IssueUpdateOperation | IssueCriterionToggleOperation | IssueNoteCreateOperation {
  return "issueIid" in operation &&
    Number.isSafeInteger(operation.issueIid) &&
    operation.issueIid >= 1;
}

function validIssueIterationOperation(
  operation: PlanOperation,
): operation is IssueIterationUpdateOperation {
  return operation.kind === "issue.iteration.update" &&
    Number.isSafeInteger(operation.issueIid) &&
    operation.issueIid >= 1 &&
    (operation.iterationId === null ||
      (typeof operation.iterationId === "string" &&
        /^gid:\/\/gitlab\/Iteration\/\d+$/.test(operation.iterationId))) &&
    (operation.iterationId === null
      ? operation.iterationIid === null && operation.iterationTitle === null
      : typeof operation.iterationIid === "number" && Number.isSafeInteger(operation.iterationIid) && operation.iterationIid > 0 &&
        typeof operation.iterationTitle === "string" && operation.iterationTitle.trim().length > 0) &&
    validExpectedUpdatedAt(operation.expectedUpdatedAt);
}

function validIssueCreateOperation(
  operation: PlanOperation,
): operation is IssueCreateOperation {
  return operation.kind === "issue.create" &&
    Boolean(operation.issue && typeof operation.issue === "object") &&
    typeof operation.issue.title === "string" &&
    operation.issue.title.trim().length > 0 &&
    (operation.issue.issue_type === undefined || isIssueType(operation.issue.issue_type));
}

function validateIssueIid(issueIid: number): void {
  if (!Number.isSafeInteger(issueIid) || issueIid < 1) {
    throw new OflowError("Issue IID must be a positive integer.", "INVALID_ISSUE_IID");
  }
}

function validateIssueIids(issueIids: number[]): number[] {
  if (!Array.isArray(issueIids) || issueIids.length === 0) {
    throw new OflowError(
      "At least one issue IID is required.",
      "INVALID_ISSUE_IIDS",
    );
  }
  const normalized = [...new Set(issueIids)];
  if (normalized.some((issueIid) => !Number.isSafeInteger(issueIid) || issueIid < 1)) {
    throw new OflowError(
      "Issue IIDs must be positive integers.",
      "INVALID_ISSUE_IIDS",
    );
  }
  if (normalized.length > MAX_BULK_ISSUES) {
    throw new OflowError(
      "Bulk issue updates are limited to " + String(MAX_BULK_ISSUES) + " issue IIDs.",
      "TOO_MANY_ISSUES",
    );
  }
  return normalized;
}

function expectedUpdatedAtFor(issues: GitLabIssue[]): Record<string, string | null> {
  return Object.fromEntries(
    issues.map((issue) => [String(issue.iid), issue.updated_at ?? null]),
  );
}

async function assertIssueFresh(
  client: GitLabClient,
  projectPath: string,
  issueIid: number,
  expectedUpdatedAt: string | null | undefined,
): Promise<void> {
  if (expectedUpdatedAt === undefined) {
    return;
  }
  const current = await client.getIssue(projectPath, issueIid);
  const actualUpdatedAt = current.updated_at ?? null;
  if (actualUpdatedAt !== expectedUpdatedAt) {
    throw new OflowError(
      "Issue #" + String(issueIid) + " changed after the plan was created; re-run the plan before applying.",
      "PLAN_TARGET_CHANGED",
    );
  }
}

function pendingBulkIssueIids(
  issueIids: number[],
  results: Array<{ iid: number }>,
): number[] {
  const completed = new Set(results.map((result) => result.iid));
  return issueIids.filter((issueIid) => !completed.has(issueIid));
}

type BulkResultIssues = NonNullable<NonNullable<PlanArtifact["result"]>["issues"]>;

function existingBulkResults(
  plan: PlanArtifact,
  kind: "issues.labels.update" | "issues.planning.update" | "issues.iteration.update" | "issues.notes.create",
): BulkResultIssues {
  if (plan.result === undefined) {
    return [];
  }
  if (plan.result.kind !== kind) {
    throw new OflowError(
      "Bulk plan contains a result for a different operation; refusing to retry.",
      "INVALID_PLAN",
    );
  }
  const results = plan.result.issues ?? [];
  const targets = new Set(
    plan.operation.kind === kind ? plan.operation.issueIids : [],
  );
  const seen = new Set<number>();
  for (const result of results) {
    if (
      !Number.isSafeInteger(result.iid) ||
      result.iid < 1 ||
      !targets.has(result.iid) ||
      seen.has(result.iid)
    ) {
      throw new OflowError(
        "Bulk plan contains invalid or duplicate partial results; refusing to retry.",
        "INVALID_PLAN",
      );
    }
    seen.add(result.iid);
  }
  return [...results];
}

async function persistBulkApplyFailure(
  root: string,
  stored: StoredPlan,
  kind: "issues.labels.update" | "issues.planning.update" | "issues.iteration.update" | "issues.notes.create",
  results: NonNullable<NonNullable<PlanArtifact["result"]>["issues"]>,
  error: unknown,
): Promise<void> {
  const failure = normalizePlanError(error);
  stored.plan.result = { kind, issues: results };
  stored.plan.applyError = {
    ...failure,
    completed: results.length,
  };
  const hadProgress = results.length > 0;
  stored.plan.state = hadProgress ? "applied-partial" : "approved";
  stored.plan.updatedAt = new Date().toISOString();
  await writeJson(stored.path, stored.plan);
  await recordPlanEvent(root, stored.plan, "apply-failed", failure);
}

function normalizePlanError(error: unknown): { code: string; message: string } {
  if (error instanceof OflowError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "APPLY_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function validExpectedUpdatedAt(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function validExpectedUpdatedAtMap(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((item) => item === null || typeof item === "string");
}

function validateBulkIssuePlanningChanges(
  changes: Pick<GitLabIssueUpdate, "milestone" | "milestone_id" | "assignee_ids">,
): Pick<GitLabIssueUpdate, "milestone" | "milestone_id" | "assignee_ids"> {
  const unsupportedFields = Object.keys(changes).filter((key) =>
    key !== "milestone" && key !== "milestone_id" && key !== "assignee_ids"
  );
  if (unsupportedFields.length > 0) {
    throw new OflowError(
      "Bulk planning updates support only --milestone and --assignee; use a single issue update for other fields.",
      "UNSUPPORTED_BULK_ISSUE_FIELD",
    );
  }
  if (changes.milestone !== undefined && !changes.milestone.trim()) {
    throw new OflowError(
      "Issue milestone cannot be empty; use none to clear it.",
      "INVALID_ISSUE_MILESTONE",
    );
  }
  const validated = validateIssueChanges(changes);
  if (Object.keys(validated).length === 0) {
    throw new OflowError(
      "No bulk planning changes were provided. Use --milestone and/or --assignee.",
      "EMPTY_PLAN",
    );
  }
  return validated;
}

function validateBulkIssueLabelChanges(
  changes: Pick<GitLabIssueUpdate, "add_labels" | "remove_labels">,
): Pick<GitLabIssueUpdate, "add_labels" | "remove_labels"> {
  const addedLabels = changes.add_labels === undefined
    ? []
    : validateIssueLabelList(changes.add_labels, "Added issue labels");
  const removedLabels = changes.remove_labels === undefined
    ? []
    : validateIssueLabelList(changes.remove_labels, "Removed issue labels");
  const overlappingLabels = addedLabels.filter((label) => removedLabels.includes(label));
  if (overlappingLabels.length > 0) {
    throw new OflowError(
      "The same label cannot be added and removed in one bulk update: " +
        overlappingLabels.join(", ") + ".",
      "CONFLICTING_ISSUE_LABELS",
    );
  }
  if (addedLabels.length === 0 && removedLabels.length === 0) {
    throw new OflowError(
      "Provide --add-labels and/or --remove-labels for a bulk update.",
      "EMPTY_PLAN",
    );
  }
  return {
    add_labels: addedLabels.length > 0 ? addedLabels.join(", ") : undefined,
    remove_labels: removedLabels.length > 0 ? removedLabels.join(", ") : undefined,
  };
}

function resolvePlanPath(root: string, input: string): string {
  const candidate = resolve(root, input);
  const planRoot = resolve(root, PLAN_DIRECTORY);
  const insidePlanRoot = (base: string, target: string): boolean => {
    const rest = relative(base, target);
    return !!rest && !rest.split(/[\\/]+/).includes("..") && !isAbsolute(rest) && rest.endsWith(".json");
  };
  // The lexical comparison above is the guard. It can also fail for a path
  // that never left the plan root, because git and the filesystem spell one
  // directory two ways: `git rev-parse` reports a forward-slash long path
  // while a Windows temp path is a backslash 8.3 short name, and `relative`
  // reports that mismatch as a ".." chain. Only when the lexical check fails
  // do we retry on canonical paths, so a real traversal fails both
  // comparisons and this widens nothing.
  if (insidePlanRoot(planRoot, candidate)) {
    return candidate;
  }
  // Retry on canonical paths. `realpathSync.native` is required here: the
  // JavaScript implementation normalizes the string it was given and keeps an
  // 8.3 short name intact, while the native binding asks the OS and returns
  // the long form. A real traversal still fails, because its canonical parent
  // resolves outside the canonical plan root.
  const canonical = (path: string): string | null => {
    try {
      return realpathSync.native(path);
    } catch {
      return null;
    }
  };
  const canonicalPlanRoot = canonical(planRoot);
  const canonicalCandidate = canonical(candidate);
  if (
    !canonicalPlanRoot ||
    !canonicalCandidate ||
    !insidePlanRoot(canonicalPlanRoot, canonicalCandidate)
  ) {
    throw new OflowError(
      "Plan paths must point to .oflow/state/plans/*.json.",
      "UNSAFE_PLAN_PATH",
    );
  }
  return candidate;
}

function assertState(plan: PlanArtifact, expected: PlanState | PlanState[], action: string): void {
  const states = Array.isArray(expected) ? expected : [expected];
  if (!states.includes(plan.state)) {
    throw new OflowError(
      "Cannot " + action + " a plan in state " + plan.state + "; expected " + states.join(" or ") + ".",
      "INVALID_PLAN_STATE",
    );
  }
}

function assertDigest(plan: PlanArtifact): void {
  if (plan.digest !== planDigest(plan)) {
    throw new OflowError(
      "Plan content changed after it was created; refusing to continue.",
      "PLAN_DIGEST_MISMATCH",
    );
  }
}

function planDigest(plan: PlanArtifact): string {
  const core = {
    managedBy: plan.managedBy,
    version: plan.version,
    id: plan.id,
    createdAt: plan.createdAt,
    sessionId: plan.sessionId,
    expiresAt: plan.expiresAt,
    operation: plan.operation,
    sourceAssessment: plan.sourceAssessment,
  };
  return createHash("sha256")
    .update(JSON.stringify(sortKeys(core)))
    .digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortKeys(nested)]),
    );
  }
  return value;
}

function cleanChanges(changes: GitLabIssueUpdate): GitLabIssueUpdate {
  return Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as GitLabIssueUpdate;
}

function validateIssueChanges(changes: GitLabIssueUpdate): GitLabIssueUpdate {
  if (
    changes.labels !== undefined &&
    (changes.add_labels !== undefined || changes.remove_labels !== undefined)
  ) {
    throw new OflowError(
      "Use either labels replacement or add_labels/remove_labels, not both.",
      "DUPLICATE_ISSUE_LABELS",
    );
  }
  const addedLabels = changes.add_labels === undefined
    ? []
    : validateIssueLabelList(changes.add_labels, "Added issue labels");
  const removedLabels = changes.remove_labels === undefined
    ? []
    : validateIssueLabelList(changes.remove_labels, "Removed issue labels");
  const overlappingLabels = addedLabels.filter((label) => removedLabels.includes(label));
  if (overlappingLabels.length > 0) {
    throw new OflowError(
      "The same label cannot be added and removed in one issue update: " +
        overlappingLabels.join(", ") + ".",
      "CONFLICTING_ISSUE_LABELS",
    );
  }
  if (changes.due_date !== undefined) {
    validateDate(changes.due_date, "Issue due date");
  }
  if (
    changes.weight !== undefined &&
    (!Number.isSafeInteger(changes.weight) || changes.weight < 0)
  ) {
    throw new OflowError(
      "Issue weight must be a non-negative integer.",
      "INVALID_ISSUE_WEIGHT",
    );
  }
  if (
    changes.epic_id !== undefined &&
    (!Number.isSafeInteger(changes.epic_id) || changes.epic_id < 0)
  ) {
    throw new OflowError(
      "Issue epic ID must be a non-negative integer; use 0 to clear the epic.",
      "INVALID_EPIC_ID",
    );
  }
  if (changes.milestone !== undefined && changes.milestone_id !== undefined) {
    throw new OflowError(
      "Use either milestone or milestone_id, not both.",
      "DUPLICATE_ISSUE_MILESTONE",
    );
  }
  if (
    changes.milestone_id !== undefined &&
    (!Number.isSafeInteger(changes.milestone_id) || changes.milestone_id < 0)
  ) {
    throw new OflowError(
      "Issue milestone ID must be a non-negative integer; use 0 to clear the milestone.",
      "INVALID_ISSUE_MILESTONE",
    );
  }
  if (changes.assignee_ids !== undefined) {
    changes.assignee_ids = validateAssigneeIds(changes.assignee_ids);
  }
  if (changes.issue_type !== undefined) {
    changes.issue_type = validateIssueType(changes.issue_type);
  }
  return changes;
}

function validateIssueCreate(issue: GitLabIssueCreate): GitLabIssueCreate {
  const title = requiredText(issue.title, "Issue title");
  if (issue.due_date !== undefined) {
    validateDate(issue.due_date, "Issue due date");
  }
  if (
    issue.weight !== undefined &&
    (!Number.isSafeInteger(issue.weight) || issue.weight < 0)
  ) {
    throw new OflowError(
      "Issue weight must be a non-negative integer.",
      "INVALID_ISSUE_WEIGHT",
    );
  }
  if (
    issue.epic_id !== undefined &&
    (!Number.isSafeInteger(issue.epic_id) || issue.epic_id < 0)
  ) {
    throw new OflowError(
      "Issue epic ID must be a non-negative integer.",
      "INVALID_EPIC_ID",
    );
  }
  const result: GitLabIssueCreate = {
    title,
    description: issue.description,
    labels: issue.labels,
    milestone: issue.milestone,
    epic_id: issue.epic_id,
    issue_type: validateIssueType(issue.issue_type),
    due_date: issue.due_date,
    weight: issue.weight,
    assignee_ids: validateAssigneeIds(issue.assignee_ids),
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  ) as GitLabIssueCreate;
}

function validateIssueType(value: IssueType | undefined): IssueType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isIssueType(value)) {
    return value;
  }
  throw new OflowError(
    "Issue type must be issue, incident, test_case, or task.",
    "INVALID_ISSUE_TYPE",
  );
}

function validateAssigneeIds(ids: number[] | undefined): number[] | undefined {
  if (ids === undefined) {
    return undefined;
  }
  if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new OflowError(
      "Issue assignee IDs must be positive integers.",
      "INVALID_ISSUE_ASSIGNEES",
    );
  }
  return [...new Set(ids)];
}

async function resolveAssigneeIds(
  client: GitLabClient,
  value: string,
): Promise<number[]> {
  const normalized = value.trim();
  if (!normalized) {
    throw new OflowError(
      "Assignee cannot be empty. Use --assignee none to clear assignments.",
      "INVALID_ISSUE_ASSIGNEES",
    );
  }
  if (["none", "null", "unassigned"].includes(normalized.toLowerCase())) {
    return [];
  }
  const usernames = [...new Set(normalized.split(",").map((item) => item.trim()).filter(Boolean))];
  const users = [];
  for (const username of usernames) {
    let matches: GitLabUser[];
    try {
      matches = await client.listUsersByUsername(username);
    } catch (error) {
      // A granular-scope token cannot search users. The raw API error names
      // the status but not the cause in oflow terms, so detect the forbidden
      // case and explain what this command needs. The shared normalizer is
      // used only as a status detector: its remediation text is written for
      // merge-request writes and would misdirect an issue-assignee user.
      const { probe, remediation } = normalizeForbidden(error);
      if (probe === "forbidden") {
        // A username can only be resolved through the users API, so widening
        // the token is the only route today. A numeric-id escape hatch is
        // sketched in docs/ROADMAP.md but not implemented; promising it here
        // would send a user looking for a flag that does not exist yet.
        const scopeHint = remediation === undefined
          ? ""
          : " Use a token with broader scopes (api, read_api) or `glab auth login`.";
        throw new OflowError(
          "Resolving --assignee " + JSON.stringify(username) + " looks the name up through " +
            "the GitLab users API, which needs the read_user or api scope, and this token " +
            "was refused." + scopeHint + " Re-authenticate with `oflow auth login <host>`, " +
            "or leave the assignee unset and set it in GitLab directly.",
          "ASSIGNEE_LOOKUP_FORBIDDEN",
        );
      }
      throw error;
    }
    if (matches.length !== 1) {
      throw new OflowError(
        matches.length === 0
          ? "Could not find GitLab user " + JSON.stringify(username) + "."
          : "GitLab username " + JSON.stringify(username) + " was not unique.",
        "ISSUE_ASSIGNEE_NOT_FOUND",
      );
    }
    users.push(matches[0]);
  }
  return users.map((user) => user.id);
}

function compactIssue(
  issue: GitLabIssue,
  kind: "issue.create" | "issue.update" = "issue.update",
): NonNullable<PlanArtifact["result"]> {
  return {
    kind,
    iid: issue.iid,
    title: issue.title,
    state: issue.state ?? null,
    issueType: issue.issue_type ?? null,
    webUrl: issue.web_url ?? null,
  };
}

function compactBulkIssuePlanningIssue(
  issue: GitLabIssue,
  changes: Pick<GitLabIssueUpdate, "milestone" | "milestone_id" | "assignee_ids">,
): NonNullable<NonNullable<PlanArtifact["result"]>["issues"]>[number] {
  return {
    iid: issue.iid,
    ...(changes.milestone !== undefined || changes.milestone_id !== undefined
      ? { milestone: namedValue(issue.milestone) }
      : {}),
    ...(changes.assignee_ids !== undefined
      ? {
          assigneeIds: (issue.assignees ?? [])
            .map((assignee) => assignee.id)
            .filter((id): id is number => typeof id === "number")
            .sort((left, right) => left - right),
        }
      : {}),
  };
}

function compactBulkIssueIterationIssue(
  issue: Pick<GitLabIssue, "iid">,
  operation: BulkIssueIterationUpdateOperation,
): NonNullable<NonNullable<PlanArtifact["result"]>["issues"]>[number] {
  return {
    iid: issue.iid,
    iterationId: operation.iterationId,
    iterationIid: operation.iterationIid,
    iterationTitle: operation.iterationTitle,
  };
}

function compactNote(
  note: GitLabNote,
  issueIid: number,
  reused = false,
): NonNullable<PlanArtifact["result"]> {
  return {
    kind: "issue.note.create",
    iid: issueIid,
    noteId: note.id,
    body: note.body,
    noteReused: reused,
    webUrl: null,
  };
}

function compactLabel(
  label: GitLabLabel,
  kind: "label.create" | "label.update",
  reused = false,
): NonNullable<PlanArtifact["result"]> {
  return {
    kind,
    labelId: label.id,
    name: label.name,
    color: label.color,
    description: label.description ?? null,
    ...(kind === "label.create" ? { resourceReused: reused } : {}),
  };
}

function compactMilestone(
  milestone: GitLabMilestone,
  kind: "milestone.create" | "milestone.update",
  reused = false,
): NonNullable<PlanArtifact["result"]> {
  return {
    kind,
    milestoneId: milestone.id,
    milestoneIid: milestone.iid,
    name: milestone.title,
    description: milestone.description ?? null,
    state: milestone.state ?? null,
    ...(kind === "milestone.create" ? { resourceReused: reused } : {}),
  };
}

function compactBoard(
  board: GitLabBoard,
  kind: "board.create" | "board.update",
  reused = false,
): NonNullable<PlanArtifact["result"]> {
  return {
    kind,
    boardId: board.id,
    name: board.name,
    ...(kind === "board.create" ? { resourceReused: reused } : {}),
  };
}

function compactBoardList(
  list: GitLabBoardList,
  kind: "board-list.create" | "board-list.update",
  reused = false,
): NonNullable<PlanArtifact["result"]> {
  return {
    kind,
    listId: list.id,
    position: list.position,
    name: list.label?.name,
    ...(kind === "board-list.create" ? { resourceReused: reused } : {}),
  };
}

function formatResult(result: NonNullable<PlanArtifact["result"]>): string {
  if (
    result.kind === "issues.labels.update" ||
    result.kind === "issues.planning.update" ||
    result.kind === "issues.iteration.update"
  ) {
    return String(result.issues?.length ?? 0) + " issues updated";
  }
  if (result.kind === "issue.note.create") {
    return "note #" + String(result.noteId ?? "unknown") +
      (result.noteReused ? " already present" : " created");
  }
  if (result.kind === "issue.criterion.toggle") {
    const criterion = result.criterion;
    return "issue #" + String(result.iid ?? "unknown") + " criterion " +
      JSON.stringify(criterion?.id ?? "unknown") +
      (criterion ? (criterion.checked ? " checked" : " unchecked") : "") +
      (result.noteId !== undefined ? " (note #" + String(result.noteId) + ")" : "");
  }
  if (result.kind === "issue.iteration.update") {
    return "issue #" + String(result.iid ?? "unknown") + " iteration set to " +
      JSON.stringify(result.iterationTitle ?? "none");
  }
  if (result.kind === "label.create" || result.kind === "label.update") {
    return "label " + JSON.stringify(result.name ?? "unknown") + " (" +
      (result.color ?? "unknown") + ")" +
      (result.resourceReused ? " already present" : "");
  }
  if (result.kind === "milestone.create" || result.kind === "milestone.update") {
    return "milestone " + JSON.stringify(result.name ?? "unknown") + " (" +
      (result.state ?? "unknown") + ")" +
      (result.resourceReused ? " already present" : "");
  }
  if (result.kind === "board.create" || result.kind === "board.update") {
    return "board " + JSON.stringify(result.name ?? "unknown") +
      " (#" + String(result.boardId ?? "unknown") + ")" +
      (result.resourceReused ? " already present" : "");
  }
  if (result.kind === "board-list.create" || result.kind === "board-list.update") {
    return "board list " + JSON.stringify(result.name ?? "unknown") +
      " (#" + String(result.listId ?? "unknown") + ")" +
      (result.resourceReused ? " already present" : "");
  }
  return (
    (result.title ?? "issue updated") +
    " (" +
    (result.state ?? "unknown") +
    ")"
  );
}


/**
 * Load the live target state for an apply exactly once and return both the
 * human-readable preview and the equivalence verdict from the same snapshot.
 * Folding the two reads prevents a race where the preview and the no-op
 * decision observe different points in time.
 */
async function loadApplySnapshot(
  plan: PlanArtifact,
  client: GitLabClient,
): Promise<ApplyPreviewResult> {
  const op = plan.operation;
  if (op.kind === "issue.update") {
    const issue = await client.getIssue(op.projectPath, op.issueIid);
    return buildSnapshotResult(plan, issue);
  }
  if (op.kind === "issue.iteration.update") {
    const issue = await client.getIssue(op.projectPath, op.issueIid);
    return buildSnapshotResult(plan, issue);
  }
  if (op.kind === "issues.iteration.update") {
    const issues = await Promise.all(
      op.issueIids.map((issueIid) => client.getIssue(op.projectPath, issueIid)),
    );
    return buildSnapshotResult(plan, issues);
  }
  if (op.kind === "issues.labels.update") {
    const issues = await Promise.all(
      op.issueIids.map((issueIid) => client.getIssue(op.projectPath, issueIid)),
    );
    return buildSnapshotResult(plan, issues);
  }
  if (op.kind === "issues.planning.update") {
    const issues = await Promise.all(
      op.issueIids.map((issueIid) => client.getIssue(op.projectPath, issueIid)),
    );
    return buildSnapshotResult(plan, issues);
  }
  if (op.kind === "label.update") {
    const labels = await client.listLabels(op.projectPath);
    return buildSnapshotResult(plan, labels);
  }
  if (op.kind === "milestone.update") {
    const milestone = await client.getMilestone(op.projectPath, op.milestoneIid);
    return buildSnapshotResult(plan, milestone);
  }
  if (op.kind === "merge_request.update") {
    const mr = await client.getMergeRequest(op.projectPath, op.iid);
    return buildSnapshotResult(plan, mr);
  }
  if (op.kind === "board.update") {
    const board = await client.getBoard(op.projectPath, op.boardId);
    return buildSnapshotResult(plan, board);
  }
  return { preview: null, equivalent: { equivalent: false } };
}

function buildSnapshotResult(
  plan: PlanArtifact,
  remote:
    | GitLabIssue
    | GitLabIssue[]
    | GitLabLabel[]
    | GitLabMilestone
    | GitLabBoard
    | GitLabMergeRequest,
): ApplyPreviewResult {
  const op = plan.operation;
  const fetchedAt = new Date().toISOString();
  const base = {
    host: op.host,
    projectPath: op.projectPath,
    fetchedAt,
  };
  if (op.kind === "issue.update") {
    const issue = remote as GitLabIssue;
    return {
      preview: {
        ...base,
        operation: op.kind,
        iid: op.issueIid,
        currentTitle: issue.title ?? null,
        fields: issueUpdateFieldDiffs(issue, op.changes),
      },
      equivalent: equivalentForIssue(plan, issue),
    };
  }
  if (op.kind === "issue.iteration.update") {
    const issue = remote as GitLabIssue;
    return {
      preview: {
        ...base,
        operation: op.kind,
        iid: op.issueIid,
        currentTitle: issue.title ?? null,
        fields: iterationUpdateFieldDiffs(issue, op),
      },
      equivalent: equivalentForIssueIteration(plan, issue),
    };
  }
  if (op.kind === "issues.iteration.update") {
    const issues = remote as GitLabIssue[];
    return {
      preview: {
        ...base,
        operation: op.kind,
        fields: issues.flatMap((issue) =>
          iterationUpdateFieldDiffs(issue, {
            iterationId: op.iterationId,
            iterationIid: op.iterationIid,
            iterationTitle: op.iterationTitle,
          })),
      },
      equivalent: equivalentForBulkIssueIteration(plan, issues),
    };
  }
  if (op.kind === "issues.labels.update") {
    const issues = remote as GitLabIssue[];
    const fields: ApplyPreviewFieldDiff[] = [];
    for (const issue of issues) {
      const before = normalizeLabels((issue.labels ?? []).join(", "));
      if (op.add_labels !== undefined) {
        const added = normalizeLabels(op.add_labels);
        const after = normalizeLabels(before.concat(added).join(", "));
        fields.push({
          field: "issue #" + String(issue.iid) + ".labels.add",
          before: before.length > 0 ? before.join(", ") : null,
          after: after.length > 0 ? after.join(", ") : null,
        });
      }
      if (op.remove_labels !== undefined) {
        const removed = normalizeLabels(op.remove_labels);
        const after = normalizeLabels(before.filter((label) => !removed.includes(label)).join(", "));
        fields.push({
          field: "issue #" + String(issue.iid) + ".labels.remove",
          before: before.length > 0 ? before.join(", ") : null,
          after: after.length > 0 ? after.join(", ") : null,
        });
      }
    }
    return {
      preview: { ...base, operation: op.kind, fields },
      equivalent: equivalentForBulkIssueLabels(plan, issues),
    };
  }
  if (op.kind === "issues.planning.update") {
    const issues = remote as GitLabIssue[];
    const fields: ApplyPreviewFieldDiff[] = [];
    for (const issue of issues) {
      fields.push(...issueUpdateFieldDiffs(issue, op.changes).map((entry) => ({
        ...entry,
        field: "issue #" + String(issue.iid) + "." + entry.field,
      })));
    }
    return {
      preview: { ...base, operation: op.kind, fields },
      equivalent: equivalentForBulkIssuePlanning(plan, issues),
    };
  }
  if (op.kind === "label.update") {
    const labels = remote as GitLabLabel[];
    const label = labels.find((item) => item.id === op.labelId) ?? labels.find((item) => item.name === op.label);
    return {
      preview: { ...base, operation: op.kind, fields: labelUpdateFieldDiffs(label, op.changes) },
      equivalent: equivalentForLabel(plan, labels),
    };
  }
  if (op.kind === "milestone.update") {
    const milestone = remote as GitLabMilestone;
    return {
      preview: { ...base, operation: op.kind, fields: milestoneUpdateFieldDiffs(milestone, op.changes) },
      equivalent: equivalentForMilestone(plan, milestone),
    };
  }
  if (op.kind === "merge_request.update") {
    const mr = remote as GitLabMergeRequest;
    return {
      preview: {
        ...base,
        operation: op.kind,
        iid: op.iid,
        currentTitle: mr.title ?? null,
        fields: mergeRequestUpdateFieldDiffs(mr, op.changes),
      },
      equivalent: equivalentForMergeRequestUpdate(plan, mr),
    };
  }
  if (op.kind === "board.update") {
    const board = remote as GitLabBoard;
    return {
      preview: { ...base, operation: op.kind, fields: boardUpdateFieldDiffs(board, op.changes) },
      equivalent: equivalentForBoard(plan, board),
    };
  }
  return { preview: null, equivalent: { equivalent: false } };
}

function equivalentForIssue(
  plan: PlanArtifact,
  issue: GitLabIssue,
): { equivalent: boolean; reason?: string } {
  const op = plan.operation;
  if (op.kind !== "issue.update") {
    return { equivalent: false };
  }
  const verification = verifyIssue(issue, op.changes);
  return verification.passed && verification.checks.length > 0
    ? { equivalent: true, reason: "issue already matches the planned changes" }
    : { equivalent: false };
}

function equivalentForIssueIteration(
  plan: PlanArtifact,
  issue: GitLabIssue,
): { equivalent: boolean; reason?: string } {
  const op = plan.operation;
  if (op.kind !== "issue.iteration.update") {
    return { equivalent: false };
  }
  const verification = verifyIssueIteration(issue, op);
  return verification.passed && verification.checks.length > 0
    ? { equivalent: true, reason: "issue iteration already matches" }
    : { equivalent: false };
}

function equivalentForBulkIssueIteration(
  plan: PlanArtifact,
  issues: GitLabIssue[],
): { equivalent: boolean; reason?: string } {
  const op = plan.operation;
  if (op.kind !== "issues.iteration.update") {
    return { equivalent: false };
  }
  const verification = verifyBulkIssueIteration(issues, op);
  return verification.passed
    ? { equivalent: true, reason: "every targeted issue iteration already matches" }
    : { equivalent: false };
}

function equivalentForBulkIssueLabels(
  plan: PlanArtifact,
  issues: GitLabIssue[],
): { equivalent: boolean; reason?: string } {
  const op = plan.operation;
  if (op.kind !== "issues.labels.update") {
    return { equivalent: false };
  }
  const verification = verifyBulkIssueLabels(issues, op);
  return verification.passed
    ? { equivalent: true, reason: "every targeted issue already has the planned labels" }
    : { equivalent: false };
}

function equivalentForBulkIssuePlanning(
  plan: PlanArtifact,
  issues: GitLabIssue[],
): { equivalent: boolean; reason?: string } {
  const op = plan.operation;
  if (op.kind !== "issues.planning.update") {
    return { equivalent: false };
  }
  const verification = verifyBulkIssuePlanning(issues, op);
  return verification.passed
    ? { equivalent: true, reason: "every targeted issue already matches the planned changes" }
    : { equivalent: false };
}

function equivalentForLabel(
  plan: PlanArtifact,
  labels: GitLabLabel[],
): { equivalent: boolean; reason?: string } {
  const op = plan.operation;
  if (op.kind !== "label.update") {
    return { equivalent: false };
  }
  const verification = verifyLabel(labels, op, op.labelId);
  return verification.passed && verification.checks.length > 0
    ? { equivalent: true, reason: "label already matches the planned changes" }
    : { equivalent: false };
}

function equivalentForMilestone(
  plan: PlanArtifact,
  milestone: GitLabMilestone,
): { equivalent: boolean; reason?: string } {
  const op = plan.operation;
  if (op.kind !== "milestone.update") {
    return { equivalent: false };
  }
  const verification = verifyMilestone(milestone, op);
  return verification.passed && verification.checks.length > 0
    ? { equivalent: true, reason: "milestone already matches the planned changes" }
    : { equivalent: false };
}

function equivalentForBoard(
  plan: PlanArtifact,
  board: GitLabBoard,
): { equivalent: boolean; reason?: string } {
  const op = plan.operation;
  if (op.kind !== "board.update") {
    return { equivalent: false };
  }
  const verification = verifyBoard(board, op);
  return verification.passed && verification.checks.length > 0
    ? { equivalent: true, reason: "board already matches the planned changes" }
    : { equivalent: false };
}

function equivalentForMergeRequestUpdate(
  plan: PlanArtifact,
  mr: GitLabMergeRequest,
): { equivalent: boolean; reason?: string } {
  const op = plan.operation;
  if (op.kind !== "merge_request.update") {
    return { equivalent: false };
  }
  const verification = verifyMergeRequestUpdate(mr, op);
  return verification.passed && verification.checks.length > 0
    ? { equivalent: true, reason: "merge request already matches the planned changes" }
    : { equivalent: false };
}

function issueUpdateFieldDiffs(
  issue: GitLabIssue,
  changes: GitLabIssueUpdate,
): ApplyPreviewFieldDiff[] {
  const diffs: ApplyPreviewFieldDiff[] = [];
  if (changes.title !== undefined) {
    diffs.push({ field: "title", before: issue.title ?? null, after: changes.title });
  }
  if (changes.description !== undefined) {
    diffs.push({ field: "description", before: issue.description ?? null, after: changes.description });
  }
  if (changes.issue_type !== undefined) {
    diffs.push({ field: "issue_type", before: issue.issue_type ?? null, after: changes.issue_type });
  }
  if (changes.state_event !== undefined) {
    const expected = changes.state_event === "close" ? "closed" : "opened";
    diffs.push({ field: "state", before: issue.state ?? null, after: expected });
  }
  if (changes.labels !== undefined) {
    const expected = normalizeLabels(changes.labels).join(", ");
    const actual = normalizeLabels((issue.labels ?? []).join(", ")).join(", ");
    diffs.push({ field: "labels", before: actual || null, after: expected || null });
  }
  if (changes.add_labels !== undefined) {
    const before = normalizeLabels((issue.labels ?? []).join(", "));
    const added = normalizeLabels(changes.add_labels);
    const after = normalizeLabels(before.concat(added).join(", "));
    diffs.push({ field: "labels.add", before: before.join(", ") || null, after: after.join(", ") || null });
  }
  if (changes.remove_labels !== undefined) {
    const before = normalizeLabels((issue.labels ?? []).join(", "));
    const removed = normalizeLabels(changes.remove_labels);
    const after = normalizeLabels(before.filter((label) => !removed.includes(label)).join(", "));
    diffs.push({ field: "labels.remove", before: before.join(", ") || null, after: after.join(", ") || null });
  }
  if (changes.milestone !== undefined) {
    diffs.push({ field: "milestone", before: namedValue(issue.milestone), after: changes.milestone });
  }
  if (changes.milestone_id !== undefined) {
    const expected = changes.milestone_id === 0 ? null : String(changes.milestone_id);
    diffs.push({ field: "milestone_id", before: issueMilestoneId(issue) || null, after: expected });
  }
  if (changes.epic_id !== undefined) {
    const expected = changes.epic_id === 0 ? null : String(changes.epic_id);
    diffs.push({ field: "epic_id", before: issueParentId(issue) || null, after: expected });
  }
  if (changes.due_date !== undefined) {
    diffs.push({ field: "due_date", before: issue.due_date ?? null, after: changes.due_date });
  }
  if (changes.weight !== undefined) {
    const before = issue.weight === null || issue.weight === undefined ? null : String(issue.weight);
    diffs.push({ field: "weight", before, after: String(changes.weight) });
  }
  if (changes.assignee_ids !== undefined) {
    const before = (issue.assignees ?? [])
      .map((assignee) => assignee.id)
      .filter((id): id is number => typeof id === "number")
      .sort((left, right) => left - right)
      .join(",");
    const after = [...new Set(changes.assignee_ids)].sort((left, right) => left - right).join(",");
    diffs.push({ field: "assignees", before: before || null, after: after || null });
  }
  return diffs;
}

function iterationUpdateFieldDiffs(
  issue: GitLabIssue,
  op: { iterationId: string | null; iterationIid: number | null; iterationTitle: string | null },
): ApplyPreviewFieldDiff[] {
  return [{
    field: "iteration",
    before: namedValue(issue.iteration),
    after: op.iterationTitle ?? null,
  }];
}

function labelUpdateFieldDiffs(
  label: GitLabLabel | undefined,
  changes: { new_name?: string; color?: string; description?: string | null },
): ApplyPreviewFieldDiff[] {
  const diffs: ApplyPreviewFieldDiff[] = [];
  diffs.push({ field: "name", before: label?.name ?? null, after: changes.new_name ?? label?.name ?? null });
  if (changes.color !== undefined) {
    diffs.push({ field: "color", before: label?.color ?? null, after: changes.color });
  }
  if (changes.description !== undefined) {
    diffs.push({ field: "description", before: label?.description ?? null, after: changes.description });
  }
  return diffs;
}

function milestoneUpdateFieldDiffs(
  milestone: GitLabMilestone,
  changes: { title?: string; description?: string | null; due_date?: string | null; start_date?: string | null; state_event?: "close" | "activate" },
): ApplyPreviewFieldDiff[] {
  const diffs: ApplyPreviewFieldDiff[] = [];
  if (changes.title !== undefined) {
    diffs.push({ field: "title", before: milestone.title ?? null, after: changes.title });
  }
  if (changes.description !== undefined) {
    diffs.push({ field: "description", before: milestone.description ?? null, after: changes.description });
  }
  if (changes.due_date !== undefined) {
    diffs.push({ field: "due_date", before: milestone.due_date ?? null, after: changes.due_date });
  }
  if (changes.start_date !== undefined) {
    diffs.push({ field: "start_date", before: milestone.start_date ?? null, after: changes.start_date });
  }
  if (changes.state_event !== undefined) {
    const expected = changes.state_event === "close" ? "closed" : "active";
    diffs.push({ field: "state", before: milestone.state ?? null, after: expected });
  }
  return diffs;
}

function boardUpdateFieldDiffs(
  board: GitLabBoard,
  changes: { name?: string; hide_backlog_list?: boolean; hide_closed_list?: boolean; assignee_id?: number | null; milestone_id?: number | null; labels?: string[]; weight?: number | null },
): ApplyPreviewFieldDiff[] {
  const diffs: ApplyPreviewFieldDiff[] = [];
  if (changes.name !== undefined) {
    diffs.push({ field: "name", before: board.name ?? null, after: changes.name });
  }
  if (changes.hide_backlog_list !== undefined) {
    diffs.push({ field: "hide_backlog_list", before: String(Boolean(board.hide_backlog_list)), after: String(changes.hide_backlog_list) });
  }
  if (changes.hide_closed_list !== undefined) {
    diffs.push({ field: "hide_closed_list", before: String(Boolean(board.hide_closed_list)), after: String(changes.hide_closed_list) });
  }
  return diffs;
}

function mergeRequestUpdateFieldDiffs(
  mr: GitLabMergeRequest,
  changes: MergeRequestUpdateOperation["changes"],
): ApplyPreviewFieldDiff[] {
  const diffs: ApplyPreviewFieldDiff[] = [];
  if (changes.title !== undefined) {
    diffs.push({ field: "title", before: mr.title ?? null, after: changes.title });
  }
  if (changes.description !== undefined) {
    diffs.push({ field: "description", before: mr.description ?? null, after: changes.description });
  }
  if (changes.target_branch !== undefined) {
    diffs.push({ field: "target_branch", before: mr.target_branch ?? null, after: changes.target_branch });
  }
  if (changes.state_event !== undefined) {
    const expected = changes.state_event === "close" ? "closed" : "opened";
    diffs.push({ field: "state", before: mr.state ?? null, after: expected });
  }
  return diffs;
}

export function formatApplyPreviewMarkdown(preview: ApplyPreview): string {
  const lines = [
    "Pre-apply preview (" + preview.operation + " on " +
      preview.host + "/" + preview.projectPath + ")",
    preview.iid !== undefined ? "  Target IID: " + String(preview.iid) : "",
    preview.currentTitle !== undefined && preview.currentTitle !== null
      ? "  Current title: " + preview.currentTitle
      : "",
    preview.fields.length > 0 ? "  Field diff:" : "  Field diff: (no changes)",
    ...preview.fields.map((entry) => {
      const before = entry.before ?? "(unset)";
      const after = entry.after ?? "(unset)";
      return "    - " + entry.field + ": " + before + " → " + after;
    }),
    "  Fetched at: " + preview.fetchedAt,
  ].filter(Boolean);
  return lines.join("\n");
}
/**
 * Postcondition verification for a delegated merge_request.create: find
 * the MR by source branch (the agent runtime chose the iid) and confirm
 * the fields the plan promised. Never trusts the agent's claim alone.
 */
async function verifyMergeRequestCreate(
  client: GitLabClient,
  operation: MergeRequestCreateOperation,
): Promise<PlanVerification> {
  const mergeRequests = await client.listMergeRequests(
    operation.projectPath,
    undefined,
    "all",
  );
  const match = mergeRequests.find(
    (candidate) => candidate.source_branch === operation.sourceBranch,
  );
  if (!match) {
    return {
      passed: false,
      checks: [
        {
          field: "merge_request",
          expected: "a merge request from " + operation.sourceBranch,
          actual: "no merge request with that source branch",
          passed: false,
        },
      ],
      reasons: [
        "Execute the delegated action through the agent runtime's GitLab MCP tool, then run verify again.",
      ],
    };
  }
  const checks: PlanVerification["checks"] = [
    check("source_branch", operation.sourceBranch, match.source_branch ?? ""),
    check("target_branch", operation.targetBranch, match.target_branch ?? ""),
    check("title", operation.title, match.title),
  ];
  if (match.description !== undefined && match.description !== null) {
    checks.push(check("description", operation.description, match.description));
  }
  const passed = checks.every((entry) => entry.passed);
  return {
    passed,
    checks,
    reasons: passed
      ? ["Merge request !" + match.iid + " matches the approved plan."]
      : ["Merge request !" + match.iid + " does not match the approved plan."],
  };
}

function verifyMergeRequestUpdate(
  mr: GitLabMergeRequest,
  operation: MergeRequestUpdateOperation,
): PlanVerification {
  const checks: PlanVerification["checks"] = [];
  if (operation.changes.title !== undefined) {
    checks.push(check("title", operation.changes.title, mr.title));
  }
  if (operation.changes.description !== undefined) {
    checks.push(check("description", operation.changes.description, mr.description ?? ""));
  }
  if (operation.changes.target_branch !== undefined) {
    checks.push(check("target_branch", operation.changes.target_branch, mr.target_branch ?? ""));
  }
  if (operation.changes.state_event !== undefined) {
    const expected = operation.changes.state_event === "close" ? "closed" : "opened";
    checks.push(check("state", expected, mr.state ?? ""));
  }
  const passed = checks.length > 0 && checks.every((entry) => entry.passed);
  return {
    passed,
    checks,
    reasons: passed
      ? ["Merge request !" + operation.iid + " matches the approved update."]
      : ["Merge request !" + operation.iid + " does not match the approved update."],
  };
}
function verifyIssue(
  issue: GitLabIssue,
  changes: GitLabIssueUpdate,
): PlanVerification {
  const checks: PlanVerification["checks"] = [];
  if (changes.title !== undefined) {
    checks.push(check("title", changes.title, issue.title));
  }
  if (changes.description !== undefined) {
    checks.push(check("description", changes.description, issue.description ?? ""));
  }
  if (changes.labels !== undefined) {
    const expected = normalizeLabels(changes.labels).join(", ");
    const actual = normalizeLabels((issue.labels ?? []).join(", ")).join(", ");
    checks.push(check("labels", expected, actual));
  }
  const actualLabels = normalizeLabels((issue.labels ?? []).join(", "));
  if (changes.add_labels !== undefined) {
    checks.push(checkLabelsPresent("labels.add", changes.add_labels, actualLabels));
  }
  if (changes.remove_labels !== undefined) {
    checks.push(checkLabelsAbsent("labels.remove", changes.remove_labels, actualLabels));
  }
  if (changes.milestone !== undefined) {
    checks.push(check("milestone", changes.milestone, namedValue(issue.milestone)));
  }
  if (changes.milestone_id !== undefined) {
    const expected = changes.milestone_id === 0 ? "" : String(changes.milestone_id);
    checks.push(check("milestone_id", expected, issueMilestoneId(issue)));
  }
  if (changes.epic_id !== undefined) {
    const expected = changes.epic_id === 0 ? "" : String(changes.epic_id);
    checks.push(check("epic_id", expected, issueParentId(issue)));
  }
  if (changes.due_date !== undefined) {
    checks.push(check("due_date", changes.due_date, issue.due_date ?? ""));
  }
  if (changes.weight !== undefined) {
    checks.push(
      check(
        "weight",
        String(changes.weight),
        issue.weight === null || issue.weight === undefined ? "" : String(issue.weight),
      ),
    );
  }
  if (changes.assignee_ids !== undefined) {
    const expected = [...new Set(changes.assignee_ids)].sort((left, right) => left - right).join(",");
    const actual = (issue.assignees ?? [])
      .map((assignee) => assignee.id)
      .filter((id): id is number => typeof id === "number")
      .sort((left, right) => left - right)
      .join(",");
    checks.push(check("assignees", expected, actual));
  }
  if (changes.state_event !== undefined) {
    const expected = changes.state_event === "close" ? "closed" : "opened";
    checks.push(check("state", expected, issue.state ?? ""));
  }
  if (changes.issue_type !== undefined) {
    checks.push(check("issue_type", changes.issue_type, issue.issue_type ?? ""));
  }
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: checks.length > 0 && failed.length === 0,
    checks,
    reasons: failed.map(
      (item) => "GitLab did not report the requested " + item.field + " value.",
    ),
  };
}

/**
 * Verifies a criterion toggle on the description text plus the audit note.
 *
 * Deliberately does NOT assert `task_completion_status.count` /
 * `completed_count`: GitLab recomputes those from the description and can
 * serve a value computed just before this write landed, so asserting the
 * counter produces false failures on a correct apply. The description is
 * echoed verbatim by GitLab, so it is the stable observable.
 */
function verifyCriterionToggle(
  issue: GitLabIssue,
  notes: GitLabNote[],
  operation: IssueCriterionToggleOperation,
): PlanVerification {
  const description = verifyIssue(issue, operation.changes);
  const checks: PlanVerification["checks"] = [...description.checks];
  // A note without a body is a note that is not ours. Guard the read: a raw
  // TypeError here would escape the verifier instead of reporting a failed
  // check, and every sibling verifier treats an absent field as a mismatch.
  const notePresent = notes.some((note) => String(note.body ?? "").trim() === operation.note.trim());
  checks.push(check("note", operation.note, notePresent ? operation.note : "not found"));
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: checks.length > 0 && failed.length === 0,
    checks,
    reasons: failed.map((item) =>
      item.field === "note"
        ? "The audit note is not on the issue."
        : "GitLab did not report the requested " + item.field + " value.",
    ),
  };
}

function verifyIssueIteration(
  issue: GitLabIssue,
  operation: IssueIterationUpdateOperation,
): PlanVerification {
  const checks: PlanVerification["checks"] = [];
  if (operation.iterationId === null) {
    checks.push(check("iteration", "none", namedValue(issue.iteration) ?? "none"));
  } else {
    const iteration = issue.iteration;
    const record = iteration && typeof iteration === "object"
      ? iteration as Record<string, unknown>
      : null;
    const actualIid = record && (typeof record.iid === "number" || typeof record.iid === "string")
      ? String(record.iid)
      : "";
    const actualId = record && (typeof record.id === "number" || typeof record.id === "string")
      ? String(record.id).split("/").pop() ?? ""
      : "";
    checks.push(check("iteration_iid", String(operation.iterationIid ?? ""), actualIid));
    checks.push(check("iteration_id", globalIdNumericPart(operation.iterationId), actualId));
    checks.push(check("iteration", operation.iterationTitle ?? "", namedValue(issue.iteration)));
  }
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: checks.length > 0 && failed.length === 0,
    checks,
    reasons: failed.map(
      (item) => "GitLab did not report the requested " + item.field + " value.",
    ),
  };
}

function verifyBulkIssueLabels(
  issues: GitLabIssue[],
  operation: BulkIssueLabelsUpdateOperation,
): PlanVerification {
  const checks: PlanVerification["checks"] = [];
  const expectedIids = new Set(operation.issueIids);
  const returnedAllTargets = issues.length === operation.issueIids.length &&
    issues.every((issue) => expectedIids.has(issue.iid));
  for (const issue of issues) {
    const actualLabels = normalizeLabels((issue.labels ?? []).join(", "));
    if (operation.add_labels !== undefined) {
      checks.push(checkLabelsPresent(
        "issue #" + String(issue.iid) + ".labels.add",
        operation.add_labels,
        actualLabels,
      ));
    }
    if (operation.remove_labels !== undefined) {
      checks.push(checkLabelsAbsent(
        "issue #" + String(issue.iid) + ".labels.remove",
        operation.remove_labels,
        actualLabels,
      ));
    }
  }
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: returnedAllTargets && checks.length > 0 && failed.length === 0,
    checks,
    reasons: [
      ...(returnedAllTargets ? [] : ["GitLab did not return every targeted issue."]),
      ...failed.map(
        (item) => "GitLab did not report the requested " + item.field + " value.",
      ),
    ],
  };
}

function verifyBulkIssuePlanning(
  issues: GitLabIssue[],
  operation: BulkIssuePlanningUpdateOperation,
): PlanVerification {
  const checks: PlanVerification["checks"] = [];
  const expectedIids = new Set(operation.issueIids);
  const returnedAllTargets = issues.length === operation.issueIids.length &&
    issues.every((issue) => expectedIids.has(issue.iid));
  for (const issue of issues) {
    const verification = verifyIssue(issue, operation.changes);
    checks.push(...verification.checks.map((item) => ({
      ...item,
      field: "issue #" + String(issue.iid) + "." + item.field,
    })));
  }
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: returnedAllTargets && checks.length > 0 && failed.length === 0,
    checks,
    reasons: [
      ...(returnedAllTargets ? [] : ["GitLab did not return every targeted issue."]),
      ...failed.map(
        (item) => "GitLab did not report the requested " + item.field + " value.",
      ),
    ],
  };
}

function verifyBulkIssueIteration(
  issues: GitLabIssue[],
  operation: BulkIssueIterationUpdateOperation,
): PlanVerification {
  const checks: PlanVerification["checks"] = [];
  const expectedIids = new Set(operation.issueIids);
  const returnedAllTargets = issues.length === operation.issueIids.length &&
    issues.every((issue) => expectedIids.has(issue.iid));
  for (const issue of issues) {
    const verification = verifyIssueIteration(issue, {
      kind: "issue.iteration.update",
      host: operation.host,
      projectPath: operation.projectPath,
      issueIid: issue.iid,
      iterationId: operation.iterationId,
      iterationIid: operation.iterationIid,
      iterationTitle: operation.iterationTitle,
    });
    checks.push(...verification.checks.map((item) => ({
      ...item,
      field: "issue #" + String(issue.iid) + "." + item.field,
    })));
  }
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: returnedAllTargets && checks.length > 0 && failed.length === 0,
    checks,
    reasons: [
      ...(returnedAllTargets ? [] : ["GitLab did not return every targeted issue."]),
      ...failed.map(
        (item) => "GitLab did not report the requested " + item.field + " value.",
      ),
    ],
  };
}

function verifyIssueNote(
  notes: GitLabNote[],
  expectedBody: string,
  noteId: number | undefined,
): PlanVerification {
  const matchingNote = noteId === undefined
    ? notes.find((note) => note.body === expectedBody)
    : notes.find((note) => note.id === noteId);
  const actual = matchingNote?.body ?? "";
  const passed = matchingNote !== undefined && actual === expectedBody;
  return {
    passed,
    checks: [check("note.body", expectedBody, actual)],
    reasons: passed ? [] : ["GitLab did not report the created note body."],
  };
}

async function verifyBulkIssueNotes(
  client: GitLabClient,
  stored: StoredPlan,
): Promise<PlanVerification> {
  const operation = stored.plan.operation;
  if (operation.kind !== "issues.notes.create") {
    throw new OflowError("Bulk note verification requires an issues.notes.create plan.", "INVALID_PLAN");
  }
  const results = stored.plan.result?.issues ?? [];
  const resultByIid = new Map(results.map((result) => [result.iid, result]));
  const checks: PlanVerification["checks"] = [];
  let missingTargets = 0;
  for (const issueIid of operation.issueIids) {
    const notes = await client.getIssueNotes(operation.projectPath, issueIid);
    const verification = verifyIssueNote(
      notes,
      operation.body,
      resultByIid.get(issueIid)?.noteId,
    );
    checks.push(...verification.checks.map((item) => ({
      ...item,
      field: "issue #" + String(issueIid) + "." + item.field,
    })));
    if (!verification.passed) {
      missingTargets += 1;
    }
  }
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: missingTargets === 0 && checks.length === operation.issueIids.length && failed.length === 0,
    checks,
    reasons: [
      ...(missingTargets === 0
        ? []
        : ["GitLab did not report the shared note body on every targeted issue."]),
      ...failed.map(
        (item) => "GitLab did not report the requested " + item.field + " value.",
      ),
    ],
  };
}

function verifyLabel(
  labels: GitLabLabel[],
  operation: LabelCreateOperation | LabelUpdateOperation,
  labelId: number | undefined,
): PlanVerification {
  const expectedName = operation.kind === "label.create"
    ? operation.name
    : operation.changes.new_name ?? operation.label;
  const label = labels.find((item) =>
    labelId !== undefined && item.id === labelId
  ) ?? labels.find((item) => item.name === expectedName);
  const checks: PlanVerification["checks"] = [
    check("label.name", expectedName, label?.name ?? ""),
  ];
  const expectedColor = operation.kind === "label.create"
    ? operation.color
    : operation.changes.color;
  if (expectedColor !== undefined) {
    checks.push(check("label.color", expectedColor, label?.color ?? ""));
  }
  const expectedDescription = operation.kind === "label.create"
    ? operation.description
    : operation.changes.description;
  if (expectedDescription !== undefined) {
    checks.push(check("label.description", expectedDescription, label?.description ?? ""));
  }
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: label !== undefined && failed.length === 0,
    checks,
    reasons: label === undefined
      ? ["GitLab did not report the requested project label."]
      : failed.map((item) => "GitLab did not report the requested " + item.field + " value."),
  };
}

function verifyMilestone(
  milestone: GitLabMilestone,
  operation: MilestoneCreateOperation | MilestoneUpdateOperation,
): PlanVerification {
  const changes = operation.kind === "milestone.create"
    ? {
        title: operation.title,
        description: operation.description,
        start_date: operation.start_date,
        due_date: operation.due_date,
      }
    : operation.changes;
  const checks: PlanVerification["checks"] = [];
  if (changes.title !== undefined) {
    checks.push(check("milestone.title", changes.title, milestone.title));
  }
  if (changes.description !== undefined) {
    checks.push(check("milestone.description", changes.description, milestone.description ?? ""));
  }
  if (changes.start_date !== undefined) {
    checks.push(check("milestone.start_date", changes.start_date, milestone.start_date ?? ""));
  }
  if (changes.due_date !== undefined) {
    checks.push(check("milestone.due_date", changes.due_date, milestone.due_date ?? ""));
  }
  if (operation.kind === "milestone.update" && operation.changes.state_event !== undefined) {
    const expected = operation.changes.state_event === "close" ? "closed" : "active";
    checks.push(check("milestone.state", expected, milestone.state ?? ""));
  }
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: checks.length > 0 && failed.length === 0,
    checks,
    reasons: failed.map(
      (item) => "GitLab did not report the requested " + item.field + " value.",
    ),
  };
}

function verifyBoard(
  board: GitLabBoard,
  operation: BoardCreateOperation | BoardUpdateOperation,
): PlanVerification {
  const expected = operation.kind === "board.create"
    ? { name: operation.name }
    : operation.changes;
  const checks: PlanVerification["checks"] = [];
  if (expected.name !== undefined) {
    checks.push(check("board.name", expected.name, board.name));
  }
  for (const field of ["hide_backlog_list", "hide_closed_list"] as const) {
    if (expected[field] !== undefined) {
      checks.push(check(field, String(expected[field]), String(board[field] ?? false)));
    }
  }
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: checks.length > 0 && failed.length === 0,
    checks,
    reasons: failed.map(
      (item) => "GitLab did not report the requested " + item.field + " value.",
    ),
  };
}

function verifyBoardList(
  list: GitLabBoardList,
  operation: BoardListCreateOperation | BoardListUpdateOperation,
): PlanVerification {
  const checks: PlanVerification["checks"] = [];
  if (operation.kind === "board-list.create") {
    const actualLabelId = list.label?.id;
    const actualLabelName = list.label?.name ?? "";
    if (actualLabelId !== undefined) {
      checks.push(check("board-list.label_id", String(operation.labelId), String(actualLabelId)));
    } else {
      checks.push(check("board-list.label", operation.labelName, actualLabelName));
    }
  } else {
    checks.push(check("board-list.position", String(operation.position), String(list.position ?? "")));
  }
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: checks.length > 0 && failed.length === 0,
    checks,
    reasons: failed.map(
      (item) => "GitLab did not report the requested " + item.field + " value.",
    ),
  };
}

function check(
  field: string,
  expected: string,
  actual: string | null,
): PlanVerification["checks"][number] {
  const safeActual = actual ?? "";
  return {
    field,
    expected,
    actual: safeActual,
    passed: expected === safeActual,
  };
}

function normalizeLabels(value: string): string[] {
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function validateIssueLabelList(value: string, field: string): string[] {
  const labels = normalizeLabels(value);
  if (labels.length === 0) {
    throw new OflowError(
      field + " must contain at least one comma-separated label.",
      "INVALID_ISSUE_LABELS",
    );
  }
  return labels;
}

/**
 * Refuse a plan that adds a label the project does not define.
 *
 * A label the project does not define cannot be added, and oflow previously
 * discovered that only at verify time -- after the plan had been approved and
 * applied. Rejecting it here keeps the failure loud and cheap, with
 * `oflow plan label create` as the documented way to add the label first.
 *
 * Removal is deliberately not checked: removing an absent label is already
 * the requested end state.
 */
async function assertIssueLabelsExist(
  client: GitLabClient,
  projectPath: string,
  addedLabels: string[],
): Promise<void> {
  if (addedLabels.length === 0) return;
  const page = await client.listLabelsPage(projectPath);
  // Truncated to the first page, this check would call every label past it
  // missing, so refuse to judge rather than accuse a label that does exist.
  if (page.pagination.hasNextPage) {
    throw new OflowError(
      "This project has more labels than one page, so their existence cannot be verified here. " +
        "Check the name in GitLab, or add it with `oflow plan label create`.",
      "LABEL_LIST_INCOMPLETE",
    );
  }
  // A stored label is one name, so trim it rather than running it through
  // normalizeLabels: that helper splits on commas, and a legal label may
  // itself contain one ("bug, urgent"), which it would tear in half.
  const available = new Set(
    page.items.map((label) => label.name.trim()).filter(Boolean),
  );
  const missing = addedLabels.filter((label) => !available.has(label));
  if (missing.length > 0) {
    throw new OflowError(
      "Label" + (missing.length === 1 ? " " : "s ") + missing.map((label) => JSON.stringify(label)).join(", ") +
        " " + (missing.length === 1 ? "does" : "do") + " not exist in " + projectPath + ". " +
        "Create " + (missing.length === 1 ? "it" : "them") +
        " first with `oflow plan label create`.",
      "UNKNOWN_ISSUE_LABEL",
    );
  }
}

function checkLabelsPresent(
  field: string,
  expectedValue: string,
  actualLabels: string[],
): PlanVerification["checks"][number] {
  const expectedLabels = normalizeLabels(expectedValue);
  const missing = expectedLabels.filter((label) => !actualLabels.includes(label));
  return {
    field,
    expected: "present: " + expectedLabels.join(", "),
    actual: actualLabels.length > 0 ? actualLabels.join(", ") : "none",
    passed: missing.length === 0,
  };
}

function checkLabelsAbsent(
  field: string,
  expectedValue: string,
  actualLabels: string[],
): PlanVerification["checks"][number] {
  const expectedLabels = normalizeLabels(expectedValue);
  const present = expectedLabels.filter((label) => actualLabels.includes(label));
  return {
    field,
    expected: "absent: " + expectedLabels.join(", "),
    actual: actualLabels.length > 0 ? actualLabels.join(", ") : "none",
    passed: present.length === 0,
  };
}

function cleanLabelChanges(changes: GitLabLabelUpdate): GitLabLabelUpdate {
  return Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as GitLabLabelUpdate;
}

function cleanBoardChanges(changes: GitLabBoardUpdate): GitLabBoardUpdate {
  return Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as GitLabBoardUpdate;
}

function validateMilestoneDates(
  startDate: string | undefined,
  dueDate: string | undefined,
): { startDate?: string; dueDate?: string } {
  const normalizedStart = validateDate(startDate, "Start date");
  const normalizedDue = validateDate(dueDate, "Due date");
  if (normalizedStart !== undefined && normalizedDue !== undefined && normalizedStart > normalizedDue) {
    throw new OflowError("Start date cannot be after due date.", "INVALID_MILESTONE_DATE_RANGE");
  }
  return { startDate: normalizedStart, dueDate: normalizedDue };
}

function validateMilestoneChanges(changes: GitLabMilestoneUpdate): GitLabMilestoneUpdate {
  const clean = Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as GitLabMilestoneUpdate;
  const result: GitLabMilestoneUpdate = {};
  if (clean.title !== undefined) {
    result.title = requiredText(clean.title, "Milestone title");
  }
  if (clean.description !== undefined) {
    result.description = clean.description;
  }
  const dates = validateMilestoneDates(clean.start_date, clean.due_date);
  if (dates.startDate !== undefined) {
    result.start_date = dates.startDate;
  }
  if (dates.dueDate !== undefined) {
    result.due_date = dates.dueDate;
  }
  if (clean.state_event !== undefined) {
    if (clean.state_event !== "close" && clean.state_event !== "activate") {
      throw new OflowError(
        "Unknown milestone state. Use closed or active.",
        "INVALID_MILESTONE_STATE",
      );
    }
    result.state_event = clean.state_event;
  }
  return result;
}

function validateDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isDateString(value)) {
    throw new OflowError(
      field + " must use YYYY-MM-DD.",
      "INVALID_MILESTONE_DATE",
    );
  }
  return value;
}

function isDateString(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]);
}

function validateMilestoneIid(milestoneIid: number): void {
  if (!Number.isSafeInteger(milestoneIid) || milestoneIid < 1) {
    throw new OflowError(
      "Milestone IID must be a positive integer.",
      "INVALID_MILESTONE_IID",
    );
  }
}

function validateBoardId(boardId: number): void {
  if (!Number.isSafeInteger(boardId) || boardId < 1) {
    throw new OflowError("Board ID must be a positive integer.", "INVALID_BOARD_ID");
  }
}

function validateBoardListId(listId: number): void {
  if (!Number.isSafeInteger(listId) || listId < 1) {
    throw new OflowError("Board list ID must be a positive integer.", "INVALID_BOARD_LIST_ID");
  }
}

function validateBoardListPosition(position: number): void {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new OflowError(
      "Board list position must be a non-negative integer.",
      "INVALID_BOARD_POSITION",
    );
  }
}

function resultMilestoneIid(milestoneIid: number | undefined): number {
  if (milestoneIid === undefined) {
    throw new OflowError(
      "Applied milestone plan is missing its remote IID.",
      "INVALID_PLAN",
    );
  }
  validateMilestoneIid(milestoneIid);
  return milestoneIid;
}

function resultIssueIid(issueIid: number | undefined): number {
  if (issueIid === undefined) {
    throw new OflowError(
      "Applied issue plan is missing its remote IID.",
      "INVALID_PLAN",
    );
  }
  validateIssueIid(issueIid);
  return issueIid;
}

function resultBoardId(boardId: number | undefined): number {
  if (boardId === undefined) {
    throw new OflowError(
      "Applied board plan is missing its remote ID.",
      "INVALID_PLAN",
    );
  }
  validateBoardId(boardId);
  return boardId;
}

function resultListId(listId: number | undefined): number {
  if (listId === undefined) {
    throw new OflowError(
      "Applied board-list plan is missing its remote ID.",
      "INVALID_PLAN",
    );
  }
  validateBoardListId(listId);
  return listId;
}

function requiredText(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw new OflowError(field + " cannot be empty.", "MISSING_FLAG_VALUE");
  }
  return normalized;
}

function isIterationClearReference(value: string): boolean {
  return ["none", "null", "unassigned"].includes(value.toLowerCase());
}

async function safeProjectIterations(
  client: GitLabClient,
  projectPath: string,
): Promise<GitLabIteration[]> {
  try {
    return await client.listProjectIterations(projectPath, "all", 100);
  } catch (error: unknown) {
    if (error instanceof GitLabApiError && error.status === 404) {
      // A missing project-iteration endpoint may mean the project exposes its
      // timebox only as a milestone. Authorization, transport, and server
      // failures must remain visible to the caller.
      return [];
    }
    throw error;
  }
}

function resolveIterationTargetSafe(
  iterations: GitLabIteration[],
  reference: string,
): Pick<IssueIterationUpdateOperation, "iterationId" | "iterationIid" | "iterationTitle"> | null {
  try {
    return resolveIterationTarget(iterations, reference);
  } catch (error: unknown) {
    if (error instanceof OflowError && error.code === "ITERATION_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

function resolveIterationTarget(
  iterations: GitLabIteration[],
  reference: string,
): Pick<IssueIterationUpdateOperation, "iterationId" | "iterationIid" | "iterationTitle"> {
  const numericReference = /^\d+$/.test(reference) ? Number(reference) : null;
  const matches = numericReference === null
    ? iterations.filter((iteration) =>
        typeof iteration.title === "string" &&
        iteration.title.trim().toLowerCase() === reference.toLowerCase())
    : iterations.filter((iteration) =>
        iteration.iid === numericReference || iteration.id === numericReference);
  if (matches.length === 0) {
    throw new OflowError(
      "Could not find project-visible iteration " + JSON.stringify(reference) + ". Use its exact title, IID, or none.",
      "ITERATION_NOT_FOUND",
    );
  }
  if (matches.length > 1) {
    throw new OflowError(
      "Iteration reference " + JSON.stringify(reference) + " matched more than one iteration; use a unique iteration IID.",
      "ITERATION_NOT_UNIQUE",
    );
  }
  const iteration = matches[0];
  if (!Number.isSafeInteger(iteration.id) || iteration.id < 1 ||
    !Number.isSafeInteger(iteration.iid) || iteration.iid < 1 ||
    typeof iteration.title !== "string" || iteration.title.trim() === "") {
    throw new OflowError(
      "GitLab returned an invalid iteration target.",
      "INVALID_GITLAB_RESPONSE",
    );
  }
  return {
    iterationId: iterationGlobalId(iteration.id),
    iterationIid: iteration.iid,
    iterationTitle: iteration.title,
  };
}

function iterationGlobalId(id: number): string {
  return "gid://gitlab/Iteration/" + String(id);
}

function globalIdNumericPart(id: string): string {
  return /\/(\d+)$/.exec(id)?.[1] ?? "";
}

function findLabel(labels: GitLabLabel[], reference: string): GitLabLabel | undefined {
  const byName = labels.find((label) => label.name === reference);
  if (byName) {
    return byName;
  }
  const id = Number(reference);
  return Number.isSafeInteger(id) && id > 0
    ? labels.find((label) => label.id === id)
    : undefined;
}

function findUniqueNamedResource<T>(
  items: T[],
  expectedName: string,
  getName: (item: T) => string | undefined,
  resourceName: string,
): T | undefined {
  const matches = items.filter((item) => getName(item) === expectedName);
  if (matches.length > 1) {
    throw new OflowError(
      "Found multiple " + resourceName + " entries named " + JSON.stringify(expectedName) +
        "; refusing ambiguous recovery.",
      "PLAN_RESOURCE_CONFLICT",
    );
  }
  return matches[0];
}

function assertLabelCreateRecoveryMatch(
  label: GitLabLabel,
  operation: LabelCreateOperation,
): void {
  const colorMatches = typeof label.color === "string" &&
    label.color.toLowerCase() === operation.color.toLowerCase();
  const descriptionMatches = optionalText(label.description) === optionalText(operation.description);
  if (!colorMatches || !descriptionMatches) {
    throw new OflowError(
      "A project label named " + JSON.stringify(operation.name) +
        " already exists with different color or description; refusing duplicate recovery.",
      "PLAN_RESOURCE_CONFLICT",
    );
  }
}

function assertMilestoneCreateRecoveryMatch(
  milestone: GitLabMilestone,
  operation: MilestoneCreateOperation,
): void {
  const datesMatch = optionalText(milestone.start_date) === optionalText(operation.start_date) &&
    optionalText(milestone.due_date) === optionalText(operation.due_date);
  const descriptionMatches = optionalText(milestone.description) === optionalText(operation.description);
  const stateMatches = typeof milestone.state !== "string" ||
    milestone.state.toLowerCase() === "active";
  if (!datesMatch || !descriptionMatches || !stateMatches) {
    throw new OflowError(
      "A project milestone named " + JSON.stringify(operation.title) +
        " already exists with different planning data; refusing duplicate recovery.",
      "PLAN_RESOURCE_CONFLICT",
    );
  }
}

function optionalText(value: string | null | undefined): string {
  return value ?? "";
}

function formatTarget(operation: PlanOperation): string {
  if (operation.kind === "issue.create") {
    return "new " + (operation.issue.issue_type ?? "issue") + " " + JSON.stringify(operation.issue.title);
  }
  if (
    operation.kind === "issue.update" ||
    operation.kind === "issue.iteration.update" ||
    operation.kind === "issue.note.create"
  ) {
    return "issue #" + operation.issueIid;
  }
  if (operation.kind === "issues.labels.update" ||
    operation.kind === "issues.planning.update" ||
    operation.kind === "issues.iteration.update" ||
    operation.kind === "issues.notes.create") {
    return "issues #" + operation.issueIids.join(", #");
  }
  if (operation.kind === "label.create") {
    return "label " + JSON.stringify(operation.name);
  }
  if (operation.kind === "label.update") {
    return "label " + JSON.stringify(operation.label);
  }
  if (operation.kind === "milestone.create") {
    return "milestone " + JSON.stringify(operation.title);
  }
  if (operation.kind === "milestone.update") {
    return "milestone #" + operation.milestoneIid;
  }
  if (operation.kind === "board.create") {
    return "board " + JSON.stringify(operation.name);
  }
  if (operation.kind === "board.update") {
    return "board #" + operation.boardId;
  }
  if (operation.kind === "board-list.create") {
    return "board #" + operation.boardId + " list for " + JSON.stringify(operation.labelName);
  }
  if (operation.kind === "merge_request.create") {
    return "merge request " + JSON.stringify(operation.sourceBranch) + " -> " + operation.targetBranch;
  }
  if (operation.kind === "merge_request.update") {
    return "merge request !" + operation.iid;
  }
  if (operation.kind === "issue.criterion.toggle") {
    // Includes the intended state so a check and its later uncheck are two
    // distinct plan targets rather than the same digest.
    return "issue #" + operation.issueIid + " " + operation.criterion.id +
      (operation.criterion.checked ? " checked" : " unchecked");
  }
  return "board #" + operation.boardId + " list #" + operation.listId;
}

function namedValue(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = record.name ?? record.title;
  return typeof name === "string" ? name : null;
}

function issueParentId(issue: GitLabIssue): string {
  const parent = issue.epic ?? issue.parent;
  if (!parent || typeof parent !== "object") {
    return "";
  }
  const id = (parent as Record<string, unknown>).id;
  return typeof id === "number" || typeof id === "string" ? String(id) : "";
}

function issueMilestoneId(issue: GitLabIssue): string {
  if (!issue.milestone || typeof issue.milestone !== "object") {
    return "";
  }
  const id = issue.milestone.id;
  return typeof id === "number" || typeof id === "string" ? String(id) : "";
}
