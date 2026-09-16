import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { OflowError } from "./errors.js";
import { readJson, writeJson } from "./fs.js";
import { getGitLabRemote } from "./git.js";
import { GitLabClient } from "./gitlab.js";
import type { GitLabIssue, GitLabIssueUpdate } from "./types.js";

export const PLAN_DIRECTORY = ".oflow/state/plans";

export type PlanState = "draft" | "approved" | "applied" | "verified";

export interface IssueUpdateOperation {
  kind: "issue.update";
  projectPath: string;
  issueIid: number;
  changes: GitLabIssueUpdate;
}

export interface PlanArtifact {
  managedBy: "oflow";
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  state: PlanState;
  digest: string;
  operation: IssueUpdateOperation;
  result?: {
    iid: number;
    title: string;
    state: string | null;
    webUrl: string | null;
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

export async function createIssueUpdatePlan(
  root: string,
  issueIid: number,
  changes: GitLabIssueUpdate,
): Promise<StoredPlan> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  if (!Number.isSafeInteger(issueIid) || issueIid < 1) {
    throw new OflowError("Issue IID must be a positive integer.", "INVALID_ISSUE_IID");
  }
  const operationChanges = cleanChanges(changes);
  if (Object.keys(operationChanges).length === 0) {
    throw new OflowError(
      "No issue changes were provided. Use --title, --description, --labels, --milestone, or --state.",
      "EMPTY_PLAN",
    );
  }

  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  await client.getIssue(remote.projectPath, issueIid);

  const now = new Date().toISOString();
  const plan: PlanArtifact = {
    managedBy: "oflow",
    version: 1,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    state: "draft",
    digest: "",
    operation: {
      kind: "issue.update",
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
  if (remote.projectPath !== stored.plan.operation.projectPath) {
    throw new OflowError(
      "The current Git remote does not match the plan target.",
      "PLAN_TARGET_MISMATCH",
    );
  }
  const result = await new GitLabClient(remote.host).updateIssue(
    stored.plan.operation.projectPath,
    stored.plan.operation.issueIid,
    stored.plan.operation.changes,
  );
  stored.plan.result = compactIssue(result);
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
  if (remote.projectPath !== stored.plan.operation.projectPath) {
    throw new OflowError(
      "The current Git remote does not match the plan target.",
      "PLAN_TARGET_MISMATCH",
    );
  }
  const issue = await new GitLabClient(remote.host).getIssue(
    stored.plan.operation.projectPath,
    stored.plan.operation.issueIid,
  );
  const verification = verifyIssue(issue, stored.plan.operation.changes);
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
  const changes = Object.entries(plan.operation.changes)
    .map(([key, value]) => "- " + key + ": " + String(value))
    .join("\n");
  const lines = [
    "# oflow plan",
    "",
    "Plan: " + stored.path,
    "ID: " + plan.id,
    "State: " + plan.state,
    "Target: " + plan.operation.projectPath + " issue #" + plan.operation.issueIid,
    "Digest: " + plan.digest,
    "",
    "Changes:",
    changes,
  ];
  if (plan.result) {
    lines.push(
      "",
      "Applied result: " +
        plan.result.title +
        " (" +
        (plan.result.state ?? "unknown") +
        ")",
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
  if (!plan || plan.managedBy !== "oflow" || plan.version !== 1) {
    throw new OflowError("Invalid oflow plan artifact: " + path, "INVALID_PLAN");
  }
  if (!plan.operation || plan.operation.kind !== "issue.update") {
    throw new OflowError("Unsupported oflow plan operation.", "UNSUPPORTED_PLAN");
  }
  return { path, plan };
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

function compactIssue(issue: GitLabIssue): NonNullable<PlanArtifact["result"]> {
  return {
    iid: issue.iid,
    title: issue.title,
    state: issue.state ?? null,
    webUrl: issue.web_url ?? null,
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
  if (changes.milestone !== undefined) {
    checks.push(check("milestone", changes.milestone, namedValue(issue.milestone)));
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

function namedValue(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = record.name ?? record.title;
  return typeof name === "string" ? name : null;
}
