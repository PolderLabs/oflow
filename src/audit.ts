import { join } from "node:path";
import { OflowError } from "./errors.js";
import { appendText, readText } from "./fs.js";
import type { PlanArtifact, PlanState } from "./plan.js";

export const AUDIT_RELATIVE_PATH = ".oflow/state/audit.jsonl";
const AUDIT_VERSION = 1;

export type PlanAuditAction =
  | "created"
  | "approved"
  | "applied"
  | "apply-failed"
  | "verified";

export interface PlanAuditEvent {
  version: 1;
  at: string;
  action: PlanAuditAction;
  planId: string;
  state: PlanState;
  operation: {
    kind: PlanArtifact["operation"]["kind"];
    host: string;
    projectPath: string;
    target: string;
  };
  details: {
    fields?: string[];
    issueCount?: number;
    resultCount?: number;
    verificationPassed?: boolean;
    verificationChecks?: number;
    errorCode?: string;
    errorMessage?: string;
  };
}

export interface AuditResult {
  path: string;
  events: PlanAuditEvent[];
  query: { limit: number };
  mayBeTruncated: boolean;
}

export async function recordPlanEvent(
  root: string,
  plan: PlanArtifact,
  action: PlanAuditAction,
  failure?: { code: string; message: string },
): Promise<void> {
  const event: PlanAuditEvent = {
    version: 1,
    at: new Date().toISOString(),
    action,
    planId: plan.id,
    state: plan.state,
    operation: {
      kind: plan.operation.kind,
      host: plan.operation.host,
      projectPath: plan.operation.projectPath,
      target: formatAuditTarget(plan.operation),
    },
    details: {
      ...auditDetails(plan, action),
      ...(failure === undefined
        ? {}
        : { errorCode: failure.code, errorMessage: failure.message }),
    },
  };
  await appendText(
    join(root, AUDIT_RELATIVE_PATH),
    JSON.stringify(event) + "\n",
  );
}

export async function readAudit(root: string, limit = 50): Promise<AuditResult> {
  const path = join(root, AUDIT_RELATIVE_PATH);
  const content = await readText(path);
  const events = content === null || content.trim() === ""
    ? []
    : content
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line, index) => parseAuditEvent(line, path, index + 1))
        .reverse();
  return {
    path,
    events: events.slice(0, limit),
    query: { limit },
    mayBeTruncated: events.length > limit,
  };
}

export function formatAuditMarkdown(result: AuditResult): string {
  const lines = [
    "# oflow audit",
    "",
    "Audit log: " + result.path,
    "Events: " + String(result.events.length) +
      (result.mayBeTruncated ? " (more available)" : ""),
    "",
  ];
  if (result.events.length === 0) {
    lines.push("_No plan lifecycle events recorded._", "");
    return lines.join("\n");
  }
  lines.push(
    ...result.events.map((event) =>
      "- " + event.at + " · " + event.action + " · " +
      event.operation.kind + " · " + event.operation.target,
    ),
    "",
  );
  return lines.join("\n");
}

function auditDetails(
  plan: PlanArtifact,
  action: PlanAuditAction,
): PlanAuditEvent["details"] {
  const operation = plan.operation;
  const details: PlanAuditEvent["details"] = {};
  if ("changes" in operation && operation.changes && typeof operation.changes === "object") {
    details.fields = Object.keys(operation.changes);
  } else if (operation.kind === "issue.create") {
    details.fields = Object.keys(operation.issue);
  } else if (
    operation.kind === "issue.iteration.update" ||
    operation.kind === "issues.iteration.update"
  ) {
    details.fields = ["iteration"];
  }
  if ("issueIids" in operation) {
    details.issueCount = operation.issueIids.length;
  }
  if (plan.result?.issues) {
    details.resultCount = plan.result.issues.length;
  }
  if (action === "verified") {
    details.verificationPassed = plan.verification?.passed ?? false;
    details.verificationChecks = plan.verification?.checks.length ?? 0;
  }
  return details;
}

function formatAuditTarget(operation: PlanArtifact["operation"]): string {
  switch (operation.kind) {
    case "issue.create":
      return "new issue";
    case "issue.update":
    case "issue.iteration.update":
      return "issue #" + String(operation.issueIid);
    case "issues.labels.update":
    case "issues.planning.update":
    case "issues.iteration.update":
      return operation.issueIids.map((iid) => "#" + String(iid)).join(", ");
    case "issue.note.create":
      return "issue #" + String(operation.issueIid) + " note";
    case "label.create":
      return "label " + operation.name;
    case "label.update":
      return "label " + operation.label;
    case "milestone.create":
      return "new milestone";
    case "milestone.update":
      return "milestone #" + String(operation.milestoneIid);
    case "board.create":
      return "new board";
    case "board.update":
      return "board #" + String(operation.boardId);
    case "board-list.create":
      return "board #" + String(operation.boardId) + " list";
    case "board-list.update":
      return "board #" + String(operation.boardId) + " list #" + String(operation.listId);
  }
}

function parseAuditEvent(line: string, path: string, lineNumber: number): PlanAuditEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OflowError(
      "Invalid JSON in " + path + " at line " + String(lineNumber) + ": " + message,
      "INVALID_AUDIT",
    );
  }
  if (!isAuditEvent(value)) {
    throw new OflowError(
      "Invalid oflow audit event in " + path + " at line " + String(lineNumber) + ".",
      "INVALID_AUDIT",
    );
  }
  return value;
}

function isAuditEvent(value: unknown): value is PlanAuditEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const operation = record.operation;
  const action = record.action;
  return record.version === AUDIT_VERSION &&
    typeof record.at === "string" &&
    typeof record.planId === "string" &&
    (action === "created" || action === "approved" || action === "applied" || action === "apply-failed" || action === "verified") &&
    (record.state === "draft" || record.state === "approved" || record.state === "applied" || record.state === "verified") &&
    operation !== null && typeof operation === "object" &&
    typeof (operation as Record<string, unknown>).kind === "string" &&
    typeof (operation as Record<string, unknown>).host === "string" &&
    typeof (operation as Record<string, unknown>).projectPath === "string" &&
    typeof (operation as Record<string, unknown>).target === "string" &&
    record.details !== null && typeof record.details === "object";
}
