import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { recordPlanEvent } from "./audit.js";
import { loadConfig } from "./config.js";
import { OflowError } from "./errors.js";
import { readJson, writeJson } from "./fs.js";
import { getGitLabRemote } from "./git.js";
import { GitLabClient } from "./gitlab.js";
import { executeIssueUpdate } from "./executor.js";
import type {
  GitLabIssue,
  GitLabIssueCreate,
  GitLabIssueUpdate,
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
  GitLabIteration,
} from "./types.js";

export const PLAN_DIRECTORY = ".oflow/state/plans";
const MAX_BULK_ISSUES = 50;

export type PlanState = "draft" | "approved" | "applied" | "verified";

export interface IssueUpdateOperation {
  kind: "issue.update";
  host: string;
  projectPath: string;
  issueIid: number;
  changes: GitLabIssueUpdate;
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

export type PlanOperation =
  | IssueCreateOperation
  | IssueUpdateOperation
  | IssueIterationUpdateOperation
  | BulkIssueLabelsUpdateOperation
  | BulkIssuePlanningUpdateOperation
  | BulkIssueIterationUpdateOperation
  | IssueNoteCreateOperation
  | LabelCreateOperation
  | LabelUpdateOperation
  | MilestoneCreateOperation
  | MilestoneUpdateOperation
  | BoardCreateOperation
  | BoardUpdateOperation
  | BoardListCreateOperation
  | BoardListUpdateOperation;

export interface PlanArtifact {
  managedBy: "oflow";
  version: 2;
  id: string;
  createdAt: string;
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
    webUrl?: string | null;
    iterationId?: string | null;
    iterationIid?: number | null;
    iterationTitle?: string | null;
    noteId?: number;
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
    }>;
  };
  execution?: {
    backend: "rest" | "glab";
  };
  verification?: PlanVerification;
  applyError?: {
    code: string;
    message: string;
    completed: number;
  };
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
      "No issue changes were provided. Use --title, --description, --labels, --add-labels, --remove-labels, --milestone, --epic, --due-date, --weight, --assignee, or --state.",
      "EMPTY_PLAN",
    );
  }

  const now = new Date().toISOString();
  const plan: PlanArtifact = {
    managedBy: "oflow",
    version: 2,
    id: randomUUID(),
    createdAt: now,
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
  const target = isIterationClearReference(reference)
    ? { iterationId: null, iterationIid: null, iterationTitle: null }
    : resolveIterationTarget(
        await client.listProjectIterations(remote.projectPath, "all", 100),
        reference,
      );
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
  const target = isIterationClearReference(reference)
    ? { iterationId: null, iterationIid: null, iterationTitle: null }
    : resolveIterationTarget(
        await client.listProjectIterations(remote.projectPath, "all", 100),
        reference,
      );
  const currentIssues = await Promise.all(
    normalizedIids.map((issueIid) => client.getIssue(remote.projectPath, issueIid)),
  );
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

  const now = new Date().toISOString();
  const plan: PlanArtifact = {
    managedBy: "oflow",
    version: 2,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    state: "draft",
    digest: "",
    operation: {
      kind: "issue.note.create",
      host: remote.host,
      projectPath: remote.projectPath,
      issueIid,
      body,
    },
  };
  plan.digest = planDigest(plan);
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeJson(path, plan);
  await recordPlanEvent(root, plan, "created");
  return { path, plan };
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

export async function approvePlan(root: string, input: string): Promise<StoredPlan> {
  const stored = await loadPlan(root, input);
  assertState(stored.plan, "draft", "approve");
  assertDigest(stored.plan);
  stored.plan.state = "approved";
  stored.plan.updatedAt = new Date().toISOString();
  await writeJson(stored.path, stored.plan);
  await recordPlanEvent(root, stored.plan, "approved");
  return stored;
}

export async function applyPlan(root: string, input: string): Promise<StoredPlan> {
  const stored = await loadPlan(root, input);
  assertState(stored.plan, "approved", "apply");
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
    } else {
      const result = await client.updateMilestone(
        stored.plan.operation.projectPath,
        stored.plan.operation.milestoneIid,
        stored.plan.operation.changes,
      );
      stored.plan.result = compactMilestone(result, "milestone.update");
    }
  }
  stored.plan.state = "applied";
  stored.plan.updatedAt = new Date().toISOString();
  await writeJson(stored.path, stored.plan);
  await recordPlanEvent(root, stored.plan, "applied");
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
      ? "Create issue:"
      : plan.operation.kind === "issue.update"
      ? "Changes:"
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
    );
  }
  lines.push("");
  return lines.join("\n");
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
  return operation.kind === "board-list.update" &&
    Number.isSafeInteger(operation.boardId) && operation.boardId > 0 &&
    Number.isSafeInteger(operation.listId) && operation.listId > 0 &&
    Number.isSafeInteger(operation.position) && operation.position >= 0;
}

function validIssueOperation(
  operation: PlanOperation,
): operation is IssueUpdateOperation | IssueNoteCreateOperation {
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
    operation.issue.title.trim().length > 0;
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
  kind: "issues.labels.update" | "issues.planning.update" | "issues.iteration.update",
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
  kind: "issues.labels.update" | "issues.planning.update" | "issues.iteration.update",
  results: NonNullable<NonNullable<PlanArtifact["result"]>["issues"]>,
  error: unknown,
): Promise<void> {
  const failure = normalizePlanError(error);
  stored.plan.result = { kind, issues: results };
  stored.plan.applyError = {
    ...failure,
    completed: results.length,
  };
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
  const candidate = resolve(root, isAbsolute(input) ? relative(root, input) : input);
  const planRoot = resolve(root, PLAN_DIRECTORY);
  const pathRelativeToPlanRoot = relative(planRoot, candidate);
  if (
    !pathRelativeToPlanRoot ||
    pathRelativeToPlanRoot.startsWith(".." + "/") ||
    isAbsolute(pathRelativeToPlanRoot) ||
    !pathRelativeToPlanRoot.endsWith(".json")
  ) {
    throw new OflowError(
      "Plan paths must point to .oflow/state/plans/*.json.",
      "UNSAFE_PLAN_PATH",
    );
  }
  return candidate;
}

function assertState(plan: PlanArtifact, expected: PlanState, action: string): void {
  if (plan.state !== expected) {
    throw new OflowError(
      "Cannot " + action + " a plan in state " + plan.state + "; expected " + expected + ".",
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
    due_date: issue.due_date,
    weight: issue.weight,
    assignee_ids: validateAssigneeIds(issue.assignee_ids),
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  ) as GitLabIssueCreate;
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
    const matches = await client.listUsersByUsername(username);
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
  const failed = checks.filter((item) => !item.passed);
  return {
    passed: checks.length > 0 && failed.length === 0,
    checks,
    reasons: failed.map(
      (item) => "GitLab did not report the requested " + item.field + " value.",
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
    return "new issue " + JSON.stringify(operation.issue.title);
  }
  if (
    operation.kind === "issue.update" ||
    operation.kind === "issue.iteration.update" ||
    operation.kind === "issue.note.create"
  ) {
    return "issue #" + operation.issueIid;
  }
  if (operation.kind === "issues.labels.update") {
    return "issues #" + operation.issueIids.join(", #");
  }
  if (operation.kind === "issues.planning.update") {
    return "issues #" + operation.issueIids.join(", #");
  }
  if (operation.kind === "issues.iteration.update") {
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
