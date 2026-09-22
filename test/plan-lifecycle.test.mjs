import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  PLAN_DIRECTORY, PLAN_TTL_MS, approvePlan, applyPlan, applyPlanDelegated,
  ingestExecutionReceipt, listPlans, discardPlan, createBoardCreatePlan, verifyPlan,
} from "../dist/plan.js";
import { readAudit, recordPlanEvent } from "../dist/audit.js";

beforeEach((t) => {
  const session = process.env.OFLOW_SESSION_ID;
  const token = process.env.GITLAB_TOKEN;
  const fetch = globalThis.fetch;
  process.env.OFLOW_SESSION_ID = "current-session";
  process.env.GITLAB_TOKEN = "synthetic-test-token";
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    return new Response(JSON.stringify(String(input).endsWith("/issues/42")
      ? { iid: 42, updated_at: "2026-01-01T00:00:00Z" }
      : { id: 1, path_with_namespace: "team/project" }));
  };
  t.after(() => {
    globalThis.fetch = fetch;
    if (session === undefined) delete process.env.OFLOW_SESSION_ID;
    else process.env.OFLOW_SESSION_ID = session;
    if (token === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = token;
  });
});

const cli = join(process.cwd(), "dist/cli.js");
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sorted(value[key])]),
  );
  return value;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "oflow-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
  await mkdir(join(root, PLAN_DIRECTORY), { recursive: true });
  await writeFile(join(root, ".oflow/config.json"), JSON.stringify({
    managedBy: "oflow", version: 1, project: { host: "gitlab.example.test", path: "team/project" },
  }));
  return root;
}
async function save(root, changes = {}) {
  const createdAt = new Date().toISOString();
  const plan = {
    managedBy: "oflow", version: 2, id: randomUUID(), createdAt, updatedAt: createdAt,
    sessionId: process.env.OFLOW_SESSION_ID?.trim() || undefined,
    expiresAt: new Date(Date.parse(createdAt) + PLAN_TTL_MS).toISOString(),
    state: "draft", operation: {
      kind: "issue.update", host: "gitlab.example.test", projectPath: "team/project",
      issueIid: 42, changes: { title: "Updated title" }, expectedUpdatedAt: "2026-01-01T00:00:00Z",
    },
    ...changes,
  };
  const core = Object.fromEntries(
    ["managedBy", "version", "id", "createdAt", "sessionId", "expiresAt", "operation", "sourceAssessment"]
      .map((key) => [key, plan[key]]),
  );
  plan.digest = createHash("sha256").update(JSON.stringify(sorted(core))).digest("hex");
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeFile(path, JSON.stringify(plan));
  return { path, plan };
}
const code = (expected) => (error) => error.code === expected;

test("new plans bind a session and a fixed 24-hour TTL covered by the digest", async (t) => {
  const root = await fixture(t);
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  const previousSession = process.env.OFLOW_SESSION_ID;
  process.env.OFLOW_SESSION_ID = "test-session";
  process.env.GITLAB_TOKEN = "synthetic-test-token";
  globalThis.fetch = async () => new Response("[]", { status: 200 });
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousSession === undefined) delete process.env.OFLOW_SESSION_ID;
    else process.env.OFLOW_SESSION_ID = previousSession;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
  });
  const stored = await createBoardCreatePlan(root, "Planning");
  assert.equal(stored.plan.sessionId, "test-session");
  assert.equal(Date.parse(stored.plan.expiresAt) - Date.parse(stored.plan.createdAt), PLAN_TTL_MS);
  await approvePlan(root, stored.path);
  stored.plan.sessionId = "tampered";
  await writeFile(stored.path, JSON.stringify(stored.plan));
  await assert.rejects(approvePlan(root, stored.path, { force: true }), code("PLAN_DIGEST_MISMATCH"));
});

test("legacy, expired and cross-session plans are readable but gated before execution", async (t) => {
  const root = await fixture(t);
  const old = new Date(Date.now() - PLAN_TTL_MS - 1000).toISOString();
  for (const [reason, changes] of [
    ["legacy", { sessionId: undefined, expiresAt: undefined }],
    ["expired", { createdAt: old, expiresAt: new Date(Date.parse(old) + PLAN_TTL_MS).toISOString() }],
    ["cross-session", { sessionId: "different-session" }],
  ]) {
    const { path, plan } = await save(root, changes);
    assert.equal((await listPlans(root)).find((row) => row.id === plan.id).lifecycle, reason);
    await assert.rejects(approvePlan(root, path), code("PLAN_LIFECYCLE_BLOCKED"));
    const approved = await approvePlan(root, path, { force: true });
    assert.equal(approved.plan.state, "approved");
    assert.equal(approved.plan.expiresAt, plan.expiresAt); // approval never renews TTL
    for (const apply of [
      () => applyPlan(root, path),
      () => applyPlanDelegated(root, path),
    ]) await assert.rejects(apply(), code("PLAN_LIFECYCLE_BLOCKED"));
  }
  const audit = await readAudit(root);
  assert.equal(audit.events.filter((event) => event.action === "lifecycle-forced").length, 3);
});

test("force cannot bypass state, target or malformed metadata; expiry does not gate verification", async (t) => {
  const root = await fixture(t);
  const { path } = await save(root, { sessionId: "different-session" });
  await assert.rejects(applyPlan(root, path, { force: true }), code("INVALID_PLAN_STATE"));
  execFileSync("git", ["-C", root, "remote", "set-url", "origin", "git@gitlab.example.test:other/project.git"]);
  await assert.rejects(approvePlan(root, path, { force: true }), code("PLAN_TARGET_MISMATCH"));
  const applied = await save(root, { state: "applied", sessionId: undefined, expiresAt: undefined });
  await assert.rejects(verifyPlan(root, applied.path), code("PLAN_TARGET_MISMATCH"));
  const invalid = await save(root, { expiresAt: "invalid" });
  await assert.rejects(approvePlan(root, invalid.path, { force: true }), code("INVALID_PLAN"));
});

test("force keeps the existing live remote precondition checks", async (t) => {
  const root = await fixture(t);
  const { path } = await save(root, { state: "approved", sessionId: "different-session" });
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "synthetic-test-token";
  let reads = 0;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/issues/")) return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    assert.equal(init?.method ?? "GET", "GET");
    reads++;
    return new Response(JSON.stringify({ iid: 42, updated_at: "2026-02-01T00:00:00Z" }));
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
  });
  await assert.rejects(applyPlan(root, path, { force: true }), /changed|stale/i);
  assert.ok(reads > 0);
  assert.equal(JSON.parse(await readFile(path, "utf8")).state, "approved");
});

test("list and discard are local, audited and preserve terminal and execution history", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await listPlans(root), []);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Local hygiene must not contact GitLab"); };
  t.after(() => { globalThis.fetch = previousFetch; });
  for (const state of ["draft", "approved"]) {
    const { plan, path } = await save(root, { state, sessionId: undefined, expiresAt: undefined });
    const row = (await listPlans(root)).find((row) => row.id === plan.id);
    assert.equal(row.state, state);
    assert.equal(row.operation, "issue.update");
    assert.match(row.target, /team\/project.*42/);
    assert.ok(row.ageSeconds >= 0);
    await discardPlan(root, plan.id);
    await assert.rejects(readFile(path), code("ENOENT"));
  }
  for (const changes of [
    { state: "applied" }, { state: "verified" },
    { state: "approved", result: { kind: "issues.labels.update", issues: [{ iid: 42 }] } },
    { state: "approved", applyError: { code: "ERROR", message: "Failure", completed: 0 } },
    { state: "approved", delegatedReceipt: { backend: "gitlab-mcp" } },
  ]) {
    const { plan, path } = await save(root, changes);
    await assert.rejects(discardPlan(root, plan.id), code("PLAN_HISTORY_PROTECTED"));
    assert.ok(await readFile(path));
  }
  const delegated = await save(root, { state: "approved" });
  await recordPlanEvent(root, delegated.plan, "delegated");
  await assert.rejects(discardPlan(root, delegated.plan.id), code("PLAN_HISTORY_PROTECTED"));
  for (const id of ["../outside", "/outside", "file.json", "..\\outside"]) {
    await assert.rejects(discardPlan(root, id), code("UNSAFE_PLAN_PATH"));
  }
  assert.equal((await readAudit(root)).events.filter((event) => event.action === "discarded").length, 2);
});

test("discard rejects symlink files", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t);
  const { path } = await save(root);
  await symlink(path, join(root, PLAN_DIRECTORY, "linked.json"));
  await assert.rejects(discardPlan(root, "linked"), code("UNSAFE_PLAN_PATH"));
  assert.ok(await readFile(path));
});

test("CLI exposes local hygiene and a scoped, visible force override", async (t) => {
  const root = await fixture(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, "--root", root], { encoding: "utf8", env: { ...process.env, GITLAB_TOKEN: "", XDG_CONFIG_HOME: root, HOME: root } });
  const { plan, path } = await save(root, { sessionId: "different-session" });
  const listed = run("plan", "list", "--json");
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).plans[0].id, plan.id);
  assert.equal(run("approve", path).status, 1);
  const forced = run("approve", path, "--force", "--json");
  assert.equal(forced.status, 1); // No live API access: force must fail closed.
  assert.match(forced.stderr, /WARNING/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).state, "draft");
  assert.equal(run("plan", "discard", plan.id, "--force").status, 1);
  assert.equal(run("plan", "discard", plan.id, "--dry-run").status, 1);
  assert.equal(run("plan", "discard").status, 1);
  assert.equal(run("plan", "list", "extra").status, 1);
  const discarded = run("plan", "discard", plan.id, "--json");
  assert.equal(discarded.status, 0, discarded.stderr);
  assert.equal(JSON.parse(discarded.stdout).discarded, true);
  assert.deepEqual(JSON.parse(run("plan", "list", "--json").stdout).plans, []);
  const help = run("help").stdout;
  assert.match(help, /24-hour TTL/);
  assert.match(help, /OFLOW_SESSION_ID/);
  assert.match(help, /plan discard <id>/);
});

test("discard rejects a symlinked plan directory without touching its contents", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const stored = await save(outside);
  await rm(join(root, PLAN_DIRECTORY), { recursive: true });
  await symlink(join(outside, PLAN_DIRECTORY), join(root, PLAN_DIRECTORY), "dir");
  await assert.rejects(discardPlan(root, stored.plan.id), code("UNSAFE_PLAN_PATH"));
  assert.ok(await readFile(stored.path));
});

test("legacy force apply succeeds only through approval and still requires independent verification", async (t) => {
  const root = await fixture(t);
  const { path } = await save(root, { sessionId: undefined, expiresAt: undefined });
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "synthetic-test-token";
  let title = "Original title";
  const methods = [];
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/issues/")) return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method === "PUT") title = "Updated title";
    return new Response(JSON.stringify({
      iid: 42, title, updated_at: "2026-01-01T00:00:00Z", labels: [], assignees: [], state: "opened",
    }));
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
  });
  await approvePlan(root, path, { force: true });
  assert.equal((await applyPlan(root, path, { force: true })).plan.state, "applied");
  assert.deepEqual(methods, ["GET", "GET", "GET", "GET", "PUT"]);
  const verified = await verifyPlan(root, path);
  assert.equal(verified.plan.state, "verified");
  assert.equal(verified.plan.verification.passed, true);
  assert.deepEqual(methods, ["GET", "GET", "GET", "GET", "PUT", "GET"]);
  const actions = (await readAudit(root)).events.map((event) => event.action);
  assert.deepEqual(actions, ["verified", "applied", "lifecycle-forced", "approved", "lifecycle-forced"]);
});

test("implicit and old shell sessions use TTL, explicit IDs compare only with explicit IDs", async (t) => {
  const root = await fixture(t);
  for (const sessionId of [undefined, "shell-12345", "current-session"]) {
    const stored = await save(root, { sessionId });
    assert.equal((await approvePlan(root, stored.path)).plan.state, "approved");
  }
  const explicit = await save(root, { sessionId: "other-session" });
  await assert.rejects(approvePlan(root, explicit.path), code("PLAN_LIFECYCLE_BLOCKED"));
  delete process.env.OFLOW_SESSION_ID;
  await approvePlan(root, explicit.path);
  globalThis.fetch = async () => new Response("[]");
  const implicit = await createBoardCreatePlan(root, "Planning");
  assert.equal(implicit.plan.sessionId, undefined);
  assert.ok(implicit.plan.expiresAt);
  // A new invocation in another shell has no PID-dependent session identity.
  const result = spawnSync(process.execPath, [cli, "approve", implicit.path, "--root", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("TTL boundary is inclusive, approval never renews it, future/malformed timestamps fail closed", async (t) => {
  const root = await fixture(t);
  const now = Date.parse("2026-01-02T00:00:00.000Z");
  t.mock.method(Date, "now", () => now);
  const createdAt = new Date(now - PLAN_TTL_MS).toISOString();
  const before = await save(root, { createdAt: new Date(now - PLAN_TTL_MS + 1).toISOString(), expiresAt: new Date(now + 1).toISOString() });
  const approved = await approvePlan(root, before.path);
  assert.equal(approved.plan.expiresAt, before.plan.expiresAt);
  const boundary = await save(root, { createdAt, expiresAt: new Date(now).toISOString() });
  await assert.rejects(approvePlan(root, boundary.path), code("PLAN_LIFECYCLE_BLOCKED"));
  for (const changes of [
    { createdAt: "bad" },
    { createdAt: new Date(now + 1).toISOString(), expiresAt: new Date(now + PLAN_TTL_MS).toISOString() },
    { createdAt, expiresAt: "2026-02-30T00:00:00.000Z" },
    { createdAt, expiresAt: new Date(now + 1).toISOString() },
    { createdAt, expiresAt: createdAt },
  ]) {
    const stored = await save(root, changes);
    await assert.rejects(approvePlan(root, stored.path, { force: true }), code("INVALID_PLAN"));
  }
});

test("late receipts retain backend/action/digest/state checks without lifecycle or network gates", async (t) => {
  const root = await fixture(t);
  const createdAt = new Date(Date.now() - PLAN_TTL_MS - 1000).toISOString();
  const { path, plan } = await save(root, {
    state: "approved", createdAt, sessionId: "other-session",
    expiresAt: new Date(Date.parse(createdAt) + PLAN_TTL_MS).toISOString(),
    operation: { kind: "merge_request.create", host: "gitlab.example.test", projectPath: "team/project",
      storyIid: 42, sourceBranch: "story/42", targetBranch: "main", title: "Story", description: "Closes #42" },
  });
  globalThis.fetch = () => { throw new Error("Receipt must not read remote state"); };
  const receipt = { backend: "gitlab-mcp", action: "merge_request.create", success: true,
    executedAt: new Date().toISOString(), result: { iid: 7 } };
  await assert.rejects(ingestExecutionReceipt(root, path, { ...receipt, backend: "rest" }), code("INVALID_RECEIPT_BACKEND"));
  await assert.rejects(ingestExecutionReceipt(root, path, { ...receipt, action: "issue.update" }), code("RECEIPT_ACTION_MISMATCH"));
  await writeFile(path, JSON.stringify({ ...plan, operation: { ...plan.operation, title: "tampered" } }));
  await assert.rejects(ingestExecutionReceipt(root, path, receipt), code("PLAN_DIGEST_MISMATCH"));
  await writeFile(path, JSON.stringify(plan));
  assert.equal((await ingestExecutionReceipt(root, path, receipt)).plan.state, "applied");
  await assert.rejects(ingestExecutionReceipt(root, path, receipt), code("INVALID_PLAN_STATE"));
  assert.deepEqual((await readAudit(root)).events.map((event) => event.action), ["receipt"]);
});

test("force approval requires a successful live recheck and audits the reason and evidence", async (t) => {
  const root = await fixture(t);
  const stored = await save(root, { sessionId: "other-session" });
  const originalFetch = globalThis.fetch;
  for (const response of [
    { id: 1, path_with_namespace: "wrong/project" },
    { iid: 43, updated_at: "2026-01-01T00:00:00Z" },
    { iid: 42, updated_at: "2026-02-01T00:00:00Z" },
  ]) {
    globalThis.fetch = async (input) => String(input).includes("/issues/") || response.path_with_namespace
      ? new Response(JSON.stringify(response)) : originalFetch(input);
    await assert.rejects(approvePlan(root, stored.path, { force: true }), code("PLAN_TARGET_CHANGED"));
    assert.equal(JSON.parse(await readFile(stored.path)).state, "draft");
    assert.equal((await readAudit(root)).events.length, 0);
  }
  globalThis.fetch = async () => { throw new Error("offline"); };
  await assert.rejects(approvePlan(root, stored.path, { force: true }), /offline/);
  globalThis.fetch = originalFetch;
  await approvePlan(root, stored.path, { force: true });
  const event = (await readAudit(root)).events.find((event) => event.action === "lifecycle-forced");
  assert.equal(event.details.lifecycleReason, "cross-session");
  assert.ok(Number.isFinite(Date.parse(event.details.recheckedAt)));
  assert.deepEqual(event.details.rechecks, ["project-identity", "issue-identity:42", "issue-updated-at:42"]);
});

test("force fails closed for stale updates without revisions and unprovable delegated branches", async (t) => {
  const root = await fixture(t);
  for (const operation of [
    { kind: "board.update", boardId: 1, changes: { name: "Planning" } },
    { kind: "label.update", label: "todo", changes: { color: "#ffffff" } },
    { kind: "milestone.update", milestoneIid: 1, changes: { title: "Sprint" } },
    { kind: "board-list.update", boardId: 1, listId: 1, position: 0 },
    { kind: "merge_request.create", storyIid: 42, sourceBranch: "story/42", targetBranch: "main", title: "Story", description: "Closes #42" },
  ]) {
    const stored = await save(root, { state: "approved", sessionId: "other-session",
      operation: { host: "gitlab.example.test", projectPath: "team/project", ...operation } });
    await assert.rejects((operation.kind === "merge_request.create" ? applyPlanDelegated : applyPlan)(root, stored.path, { force: true }), code("PLAN_RECHECK_UNSUPPORTED"));
  }
  const stored = await save(root, { sessionId: "other-session" });
  const noRevision = await save(root, { sessionId: "other-session", operation: { ...stored.plan.operation, expectedUpdatedAt: undefined } });
  await assert.rejects(approvePlan(root, noRevision.path, { force: true }), code("PLAN_TARGET_CHANGED"));
});

test("failed unlink never records a successful discard; corrupt plans do not hide healthy rows", async (t) => {
  const root = await fixture(t);
  const stored = await save(root);
  const original = fs.unlink;
  fs.unlink = async () => { throw Object.assign(new Error("synthetic unlink denied"), { code: "EACCES" }); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(discardPlan(root, stored.plan.id), code("EACCES"));
  } finally {
    fs.unlink = original;
    syncBuiltinESMExports();
  }
  assert.ok(await readFile(stored.path));
  assert.equal((await readAudit(root)).events.length, 0);
  await writeFile(join(root, PLAN_DIRECTORY, "broken.json"), "{");
  const invalid = await save(root, { expiresAt: "invalid" });
  const rows = await listPlans(root);
  assert.equal(rows.find((row) => row.id === stored.plan.id).lifecycle, "current");
  for (const id of ["broken", invalid.plan.id]) {
    assert.equal(rows.find((row) => row.id === id).lifecycle, "invalid");
    assert.ok(rows.find((row) => row.id === id).error);
  }
});

test("apply records a pre-apply preview with target IID, current title, and field diff", async (t) => {
  const root = await fixture(t);
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "synthetic-test-token";
  let currentTitle = "Original title";
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/issues/")) {
      return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    }
    const method = init?.method ?? "GET";
    if (method === "PUT") currentTitle = "Updated title";
    return new Response(JSON.stringify({
      iid: 42, title: currentTitle, updated_at: "2026-01-01T00:00:00Z",
      labels: [], assignees: [], state: "opened",
    }));
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
  });
  const { path } = await save(root);
  await approvePlan(root, path);
  const stored = await applyPlan(root, path);
  assert.equal(stored.plan.state, "applied");
  assert.ok(stored.plan.preview, "expected a pre-apply preview snapshot");
  assert.equal(stored.plan.preview.operation, "issue.update");
  assert.equal(stored.plan.preview.iid, 42);
  assert.equal(stored.plan.preview.currentTitle, "Original title");
  const titleDiff = stored.plan.preview.fields.find((entry) => entry.field === "title");
  assert.ok(titleDiff, "expected a title field diff");
  assert.equal(titleDiff.before, "Original title");
  assert.equal(titleDiff.after, "Updated title");
});

test("apply detects an equivalent remote state and records a verified no-op instead of a mutation", async (t) => {
  const root = await fixture(t);
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "synthetic-test-token";
  let mutationAttempted = false;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/issues/")) {
      return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    }
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      mutationAttempted = true;
      return new Response(JSON.stringify({
        iid: 42, title: "Updated title", updated_at: "2026-01-01T00:00:00Z",
        labels: [], assignees: [], state: "opened",
      }));
    }
    // Live remote already matches the plan (title was updated externally).
    return new Response(JSON.stringify({
      iid: 42, title: "Updated title", updated_at: "2026-01-01T00:00:00Z",
      labels: [], assignees: [], state: "opened",
    }));
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
  });
  const { path } = await save(root);
  await approvePlan(root, path);
  const stored = await applyPlan(root, path);
  assert.equal(stored.plan.state, "verified");
  assert.equal(stored.plan.noOp, true);
  assert.equal(mutationAttempted, false, "expected no PUT to be issued when state is equivalent");
  assert.ok(stored.plan.verification.passed);
  const actions = (await readAudit(root)).events.map((event) => event.action);
  assert.ok(actions.includes("verified"));
});

test("apply falls through to the mutation when the live state does not yet match", async (t) => {
  const root = await fixture(t);
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "synthetic-test-token";
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/issues/")) {
      return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    }
    const method = init?.method ?? "GET";
    return new Response(JSON.stringify({
      iid: 42, title: method === "PUT" ? "Updated title" : "Original title",
      updated_at: "2026-01-01T00:00:00Z", labels: [], assignees: [], state: "opened",
    }));
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
  });
  const { path } = await save(root);
  await approvePlan(root, path);
  const stored = await applyPlan(root, path);
  assert.equal(stored.plan.state, "applied");
  assert.equal(stored.plan.noOp, undefined);
  assert.ok(stored.plan.preview);
});

test("formatPlanMarkdown renders the pre-apply preview, field diff, and no-op notice", async (t) => {
  const root = await fixture(t);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/issues/")) {
      return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    }
    const method = init?.method ?? "GET";
    return new Response(JSON.stringify({
      iid: 42, title: method === "PUT" ? "Updated title" : "Original title",
      updated_at: "2026-01-01T00:00:00Z", labels: [], assignees: [], state: "opened",
    }));
  };
  t.after(() => globalThis.fetch = previousFetch);
  const { path } = await save(root);
  await approvePlan(root, path);
  const applied = await applyPlan(root, path);
  const markdown = await import("../dist/plan.js").then((m) => m.formatPlanMarkdown(applied));
  assert.match(markdown, /Pre-apply preview \(issue\.update on gitlab\.example\.test\/team\/project\)/);
  assert.match(markdown, /Target IID: 42/);
  assert.match(markdown, /Current title: Original title/);
  assert.match(markdown, /- title: Original title → Updated title/);
});

test("apply result on the JSON-serialized stored plan exposes the preview payload", async (t) => {
  const root = await fixture(t);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/issues/")) {
      return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    }
    const method = init?.method ?? "GET";
    return new Response(JSON.stringify({
      iid: 42, title: method === "PUT" ? "Updated title" : "Original title",
      updated_at: "2026-01-01T00:00:00Z", labels: [], assignees: [], state: "opened",
    }));
  };
  t.after(() => globalThis.fetch = previousFetch);
  const { path } = await save(root);
  await approvePlan(root, path);
  const applied = await applyPlan(root, path);
  const serialized = JSON.parse(JSON.stringify(applied));
  assert.ok(serialized.plan.preview, "JSON output must include pre-apply preview");
  assert.equal(serialized.plan.preview.iid, 42);
  assert.equal(serialized.plan.preview.currentTitle, "Original title");
  assert.ok(serialized.plan.preview.fields.some((entry) => entry.field === "title"));
  assert.equal(serialized.plan.noOp, undefined);
});

test("apply no-op result carries preview payload, noOp flag, and verified state in JSON output", async (t) => {
  const root = await fixture(t);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/issues/")) {
      return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    }
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      return new Response("mutation should not have happened", { status: 500 });
    }
    return new Response(JSON.stringify({
      iid: 42, title: "Updated title", updated_at: "2026-01-01T00:00:00Z",
      labels: [], assignees: [], state: "opened",
    }));
  };
  t.after(() => globalThis.fetch = previousFetch);
  const { path } = await save(root);
  await approvePlan(root, path);
  const result = await applyPlan(root, path);
  const serialized = JSON.parse(JSON.stringify(result));
  assert.equal(serialized.plan.state, "verified");
  assert.equal(serialized.plan.noOp, true);
  assert.ok(serialized.plan.preview);
  assert.equal(serialized.plan.preview.iid, 42);
});


test("milestone_id: 0 against a remote with milestone: null is equivalent (no-op)", async (t) => {
  const root = await fixture(t);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (!String(input).includes("/issues/")) {
      return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    }
    return new Response(JSON.stringify({
      iid: 42, title: "Original title", updated_at: "2026-01-01T00:00:00Z",
      labels: [], assignees: [], state: "opened", milestone: null,
    }));
  };
  t.after(() => globalThis.fetch = previousFetch);
  const { path, plan } = await save(root, {
    operation: {
      kind: "issue.update", host: "gitlab.example.test", projectPath: "team/project",
      issueIid: 42, changes: { milestone_id: 0 }, expectedUpdatedAt: "2026-01-01T00:00:00Z",
    },
  });
  await approvePlan(root, path);
  const stored = await applyPlan(root, path);
  assert.equal(stored.plan.state, "verified");
  assert.equal(stored.plan.noOp, true);
});

test("milestone_id: 0 against a remote with a real milestone is NOT equivalent (must mutate)", async (t) => {
  const root = await fixture(t);
  let putAttempted = false;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/issues/")) {
      return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    }
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      putAttempted = true;
      return new Response(JSON.stringify({
        iid: 42, title: "Original title", updated_at: "2026-01-01T00:00:00Z",
        labels: [], assignees: [], state: "opened", milestone: null,
      }));
    }
    return new Response(JSON.stringify({
      iid: 42, title: "Original title", updated_at: "2026-01-01T00:00:00Z",
      labels: [], assignees: [], state: "opened",
      milestone: { id: 7, title: "v1.0" },
    }));
  };
  t.after(() => globalThis.fetch = previousFetch);
  const { path } = await save(root, {
    operation: {
      kind: "issue.update", host: "gitlab.example.test", projectPath: "team/project",
      issueIid: 42, changes: { milestone_id: 0 }, expectedUpdatedAt: "2026-01-01T00:00:00Z",
    },
  });
  await approvePlan(root, path);
  const stored = await applyPlan(root, path);
  assert.equal(stored.plan.state, "applied");
  assert.equal(stored.plan.noOp, undefined);
  assert.equal(putAttempted, true);
});

test("assignee_ids: [] against a remote with no assignees is equivalent (no-op)", async (t) => {
  const root = await fixture(t);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (!String(input).includes("/issues/")) {
      return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    }
    return new Response(JSON.stringify({
      iid: 42, title: "Original title", updated_at: "2026-01-01T00:00:00Z",
      labels: [], assignees: [], state: "opened",
    }));
  };
  t.after(() => globalThis.fetch = previousFetch);
  const { path } = await save(root, {
    operation: {
      kind: "issue.update", host: "gitlab.example.test", projectPath: "team/project",
      issueIid: 42, changes: { assignee_ids: [] }, expectedUpdatedAt: "2026-01-01T00:00:00Z",
    },
  });
  await approvePlan(root, path);
  const stored = await applyPlan(root, path);
  assert.equal(stored.plan.state, "verified");
  assert.equal(stored.plan.noOp, true);
});

test("labels order change is equivalent (no-op) due to order-insensitive comparison", async (t) => {
  const root = await fixture(t);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (!String(input).includes("/issues/")) {
      return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    }
    return new Response(JSON.stringify({
      iid: 42, title: "Original title", updated_at: "2026-01-01T00:00:00Z",
      labels: ["backend", "frontend"], assignees: [], state: "opened",
    }));
  };
  t.after(() => globalThis.fetch = previousFetch);
  const { path } = await save(root, {
    operation: {
      kind: "issue.update", host: "gitlab.example.test", projectPath: "team/project",
      issueIid: 42, changes: { labels: "frontend,backend" },
      expectedUpdatedAt: "2026-01-01T00:00:00Z",
    },
  });
  await approvePlan(root, path);
  const stored = await applyPlan(root, path);
  assert.equal(stored.plan.state, "verified");
  assert.equal(stored.plan.noOp, true);
});

test("apply no-op then verify roundtrip: state stays verified and no second mutation", async (t) => {
  const root = await fixture(t);
  let putAttempts = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/issues/")) {
      return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project" }));
    }
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      putAttempts += 1;
      return new Response(JSON.stringify({
        iid: 42, title: "Updated title", updated_at: "2026-01-01T00:00:00Z",
        labels: [], assignees: [], state: "opened",
      }));
    }
    return new Response(JSON.stringify({
      iid: 42, title: "Updated title", updated_at: "2026-01-01T00:00:00Z",
      labels: [], assignees: [], state: "opened",
    }));
  };
  t.after(() => globalThis.fetch = previousFetch);
  const { path } = await save(root);
  await approvePlan(root, path);
  const applied = await applyPlan(root, path);
  assert.equal(applied.plan.state, "verified");
  assert.equal(applied.plan.noOp, true);
  assert.equal(putAttempts, 0);
  // Explicit verifyPlan on the no-op path: still passes, no PUT.
  const verified = await verifyPlan(root, path);
  assert.equal(verified.plan.state, "verified");
  assert.equal(putAttempts, 0);
});
