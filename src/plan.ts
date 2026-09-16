import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { OflowError } from "./errors.js";
import { readJson, writeJson } from "./fs.js";
import { getGitLabRemote } from "./git.js";
import { GitLabClient } from "./gitlab.js";
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
} from "./types.js";

export const PLAN_DIRECTORY = ".oflow/state/plans";

export type PlanState = "draft" | "approved" | "applied" | "verified";

export interface IssueUpdateOperation {
  kind: "issue.update";
  host: string;
  projectPath: string;
  issueIid: number;
  changes: GitLabIssueUpdate;
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
  result?: {
    kind: PlanOperation["kind"];
    iid?: number;
    title?: string;
    body?: string;
    state?: string | null;
    webUrl?: string | null;
    noteId?: number;
    labelId?: number;
    name?: string;
    color?: string;
    description?: string | null;
    milestoneId?: number;
    milestoneIid?: number;
    boardId?: number;
    listId?: number;
    position?: number;
  };
  verification?: PlanVerification;
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
  return { path, plan };
}

export async function createIssueUpdatePlan(
  root: string,
  issueIid: number,
  changes: GitLabIssueUpdate,
  assignee?: string,
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
  await client.getIssue(remote.projectPath, issueIid);
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
      "No issue changes were provided. Use --title, --description, --labels, --milestone, --epic, --due-date, --weight, --assignee, or --state.",
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
    },
  };
  plan.digest = planDigest(plan);
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeJson(path, plan);
  return { path, plan };
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
  return { path, plan };
}

export async function approvePlan(root: string, input: string): Promise<StoredPlan> {
  const stored = await loadPlan(root, input);
  assertState(stored.plan, "draft", "approve");
  assertDigest(stored.plan);
  stored.plan.state = "approved";
  stored.plan.updatedAt = new Date().toISOString();
  await writeJson(stored.path, stored.plan);
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
    const result = await client.updateIssue(
      stored.plan.operation.projectPath,
      stored.plan.operation.issueIid,
      stored.plan.operation.changes,
    );
    stored.plan.result = compactIssue(result);
  } else if (stored.plan.operation.kind === "issue.note.create") {
    const result = await client.createIssueNote(
      stored.plan.operation.projectPath,
      stored.plan.operation.issueIid,
      { body: stored.plan.operation.body },
    );
    stored.plan.result = compactNote(result, stored.plan.operation.issueIid);
  } else if (stored.plan.operation.kind === "label.create") {
    const result = await client.createLabel(
      stored.plan.operation.projectPath,
      {
        name: stored.plan.operation.name,
        color: stored.plan.operation.color,
        description: stored.plan.operation.description,
      },
    );
    stored.plan.result = compactLabel(result, "label.create");
  } else if (stored.plan.operation.kind === "board.create") {
    const result = await client.createBoard(
      stored.plan.operation.projectPath,
      { name: stored.plan.operation.name },
    );
    stored.plan.result = compactBoard(result, "board.create");
  } else if (stored.plan.operation.kind === "board.update") {
    const result = await client.updateBoard(
      stored.plan.operation.projectPath,
      stored.plan.operation.boardId,
      stored.plan.operation.changes,
    );
    stored.plan.result = compactBoard(result, "board.update");
  } else if (stored.plan.operation.kind === "board-list.create") {
    const result = await client.createBoardList(
      stored.plan.operation.projectPath,
      stored.plan.operation.boardId,
      { label_id: stored.plan.operation.labelId },
    );
    stored.plan.result = compactBoardList(result, "board-list.create");
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
      const result = await client.createMilestone(
        stored.plan.operation.projectPath,
        {
          title: stored.plan.operation.title,
          description: stored.plan.operation.description,
          start_date: stored.plan.operation.start_date,
          due_date: stored.plan.operation.due_date,
        },
      );
      stored.plan.result = compactMilestone(result, "milestone.create");
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
    "",
    plan.operation.kind === "issue.create"
      ? "Create issue:"
      : plan.operation.kind === "issue.update"
        ? "Changes:"
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
      Boolean(operation.changes && typeof operation.changes === "object");
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

function compactNote(
  note: GitLabNote,
  issueIid: number,
): NonNullable<PlanArtifact["result"]> {
  return {
    kind: "issue.note.create",
    iid: issueIid,
    noteId: note.id,
    body: note.body,
    webUrl: null,
  };
}

function compactLabel(
  label: GitLabLabel,
  kind: "label.create" | "label.update",
): NonNullable<PlanArtifact["result"]> {
  return {
    kind,
    labelId: label.id,
    name: label.name,
    color: label.color,
    description: label.description ?? null,
  };
}

function compactMilestone(
  milestone: GitLabMilestone,
  kind: "milestone.create" | "milestone.update",
): NonNullable<PlanArtifact["result"]> {
  return {
    kind,
    milestoneId: milestone.id,
    milestoneIid: milestone.iid,
    name: milestone.title,
    description: milestone.description ?? null,
    state: milestone.state ?? null,
  };
}

function compactBoard(
  board: GitLabBoard,
  kind: "board.create" | "board.update",
): NonNullable<PlanArtifact["result"]> {
  return {
    kind,
    boardId: board.id,
    name: board.name,
  };
}

function compactBoardList(
  list: GitLabBoardList,
  kind: "board-list.create" | "board-list.update",
): NonNullable<PlanArtifact["result"]> {
  return {
    kind,
    listId: list.id,
    position: list.position,
    name: list.label?.name,
  };
}

function formatResult(result: NonNullable<PlanArtifact["result"]>): string {
  if (result.kind === "issue.note.create") {
    return "note #" + String(result.noteId ?? "unknown") + " created";
  }
  if (result.kind === "label.create" || result.kind === "label.update") {
    return "label " + JSON.stringify(result.name ?? "unknown") + " (" +
      (result.color ?? "unknown") + ")";
  }
  if (result.kind === "milestone.create" || result.kind === "milestone.update") {
    return "milestone " + JSON.stringify(result.name ?? "unknown") + " (" +
      (result.state ?? "unknown") + ")";
  }
  if (result.kind === "board.create" || result.kind === "board.update") {
    return "board " + JSON.stringify(result.name ?? "unknown") +
      " (#" + String(result.boardId ?? "unknown") + ")";
  }
  if (result.kind === "board-list.create" || result.kind === "board-list.update") {
    return "board list " + JSON.stringify(result.name ?? "unknown") +
      " (#" + String(result.listId ?? "unknown") + ")";
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

function formatTarget(operation: PlanOperation): string {
  if (operation.kind === "issue.create") {
    return "new issue " + JSON.stringify(operation.issue.title);
  }
  if (operation.kind === "issue.update" || operation.kind === "issue.note.create") {
    return "issue #" + operation.issueIid;
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
