import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import {
  PLAN_DIRECTORY, PLAN_TTL_MS, approvePlan, applyPlan, applyPlanDelegated, verifyPlan,
} from "../dist/plan.js";

beforeEach((t) => {
  const session = process.env.OFLOW_SESSION_ID;
  const token = process.env.GITLAB_TOKEN;
  const fetch = globalThis.fetch;
  process.env.OFLOW_SESSION_ID = "current-session";
  process.env.GITLAB_TOKEN = "synthetic-test-token";
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  t.after(() => {
    globalThis.fetch = fetch;
    if (session === undefined) delete process.env.OFLOW_SESSION_ID;
    else process.env.OFLOW_SESSION_ID = session;
    if (token === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = token;
  });
});

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sorted(value[key])]),
  );
  return value;
}

const REMOTE_MERGEREQUEST = {
  iid: 7,
  title: "Original title",
  description: "Original body",
  state: "opened",
  target_branch: "main",
  updated_at: "2026-01-01T00:00:00Z",
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "oflow-mr-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--initial-branch=main", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
  await mkdir(join(root, PLAN_DIRECTORY), { recursive: true });
  await writeFile(join(root, ".oflow/config.json"), JSON.stringify({
    managedBy: "oflow", version: 1, project: { host: "gitlab.example.test", path: "team/project" },
  }));
  return root;
}

function mergeRequestResponse(overrides = {}) {
  return { ...REMOTE_MERGEREQUEST, ...overrides };
}

async function saveUpdatePlan(root, changes = {}) {
  const createdAt = new Date().toISOString();
  const plan = {
    managedBy: "oflow", version: 2, id: randomUUID(), createdAt, updatedAt: createdAt,
    sessionId: process.env.OFLOW_SESSION_ID?.trim() || undefined,
    expiresAt: new Date(Date.parse(createdAt) + PLAN_TTL_MS).toISOString(),
    state: "draft", operation: {
      kind: "merge_request.update", host: "gitlab.example.test", projectPath: "team/project",
      iid: 7, expectedUpdatedAt: "2026-01-01T00:00:00Z",
      changes: { description: "Updated body" },
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

function mrFetchState(initial = mergeRequestResponse()) {
  const calls = [];
  const state = { mr: initial, calls };
  state.install = () => {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method, body: init?.body });
      if (method === "PUT") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.has("title")) state.mr = { ...state.mr, title: body.get("title") };
        if (body.has("description")) state.mr = { ...state.mr, description: body.get("description") };
        if (body.has("state_event")) {
          state.mr = {
            ...state.mr,
            state: body.get("state_event") === "close" ? "closed" : "opened",
          };
        }
        if (body.has("target_branch")) {
          state.mr = { ...state.mr, target_branch: body.get("target_branch") };
        }
        state.mr = { ...state.mr, updated_at: "2026-02-02T00:00:00Z" };
      }
      const payload = String(input).includes("/merge_requests/")
        ? state.mr
        : { id: 1, path_with_namespace: "team/project", default_branch: "main" };
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    return () => { globalThis.fetch = previous; };
  };
  return state;
}

test("mr update plan captures expectedUpdatedAt and applies via REST PUT", async (t) => {
  const root = await fixture(t);
  const state = mrFetchState(mergeRequestResponse());
  const restore = state.install();
  t.after(restore);

  const { path, plan } = await saveUpdatePlan(root);
  assert.equal(plan.operation.expectedUpdatedAt, "2026-01-01T00:00:00Z");

  await approvePlan(root, path);
  const applied = await applyPlan(root, path);

  assert.equal(applied.plan.state, "applied");
  assert.equal(applied.plan.result?.kind, "merge_request.update");
  assert.equal(applied.plan.result?.iid, 7);
  assert.equal(applied.plan.execution?.backend, "rest");
  const put = state.calls.find((call) => call.method === "PUT");
  assert.ok(put, "expected a PUT to the merge request endpoint");
  assert.ok(put.url.includes("/merge_requests/7"), "PUT should target MR !7");
  assert.ok(String(put.body).includes("Updated+body"), "PUT form body should carry the new description");

  const verified = await verifyPlan(root, path);
  assert.equal(verified.plan.verification?.passed, true);
  assert.ok(verified.plan.verification.checks.some((entry) => entry.field === "description"));
});


test("delegated apply rejects merge-request update plans", async (t) => {
  const root = await fixture(t);
  const stored = await saveUpdatePlan(root, {
    operation: {
      kind: "merge_request.update", host: "gitlab.example.test", projectPath: "team/project",
      iid: 7, expectedUpdatedAt: "2026-01-01T00:00:00Z", changes: { title: "Updated title" },
    },
  });
  await approvePlan(root, stored.path);
  await assert.rejects(
    () => applyPlanDelegated(root, stored.path),
    code("UNSUPPORTED_DELEGATED_ACTION"),
  );
});
test("mr update apply skips the PUT when the MR already matches (no-op equivalence)", async (t) => {
  const root = await fixture(t);
  const state = mrFetchState(mergeRequestResponse({ description: "Updated body" }));
  const restore = state.install();
  t.after(restore);

  const { path } = await saveUpdatePlan(root);
  await approvePlan(root, path);
  const applied = await applyPlan(root, path);

  assert.equal(applied.plan.state, "verified");
  assert.equal(applied.plan.noOp, true);
  assert.equal(state.calls.filter((call) => call.method === "PUT").length, 0, "no PUT when already equivalent");
  const verified = await verifyPlan(root, path);
  assert.equal(verified.plan.verification?.passed, true);
});

test("mr update with empty changes is rejected at plan time", async (t) => {
  const root = await fixture(t);
  const state = mrFetchState();
  const restore = state.install();
  t.after(restore);

  const { path, plan } = await saveUpdatePlan(root, {
    operation: {
      kind: "merge_request.update", host: "gitlab.example.test", projectPath: "team/project",
      iid: 7, expectedUpdatedAt: "2026-01-01T00:00:00Z", changes: {},
    },
  });
  assert.equal(plan.operation.changes.description, undefined);
  await assert.rejects(approvePlan(root, path), code("UNSUPPORTED_PLAN"));
});

test("mr update plan-time validation: createMergeRequestUpdatePlan rejects empty changes", async (t) => {
  const root = await fixture(t);
  const { createMergeRequestUpdatePlan } = await import("../dist/plan.js");
  await assert.rejects(
    createMergeRequestUpdatePlan({ root, iid: 7 }),
    code("INVALID_PLAN_OPTION"),
  );
});

test("mr update plan-time validation: createMergeRequestUpdatePlan reads live MR and captures revision", async (t) => {
  const root = await fixture(t);
  const { createMergeRequestUpdatePlan } = await import("../dist/plan.js");
  const state = mrFetchState(mergeRequestResponse({ updated_at: "2026-03-04T05:06:07Z" }));
  const restore = state.install();
  t.after(restore);

  const stored = await createMergeRequestUpdatePlan({
    root, iid: 7, description: "Fresh from file",
  });
  assert.equal(stored.plan.operation.kind, "merge_request.update");
  assert.equal(stored.plan.operation.expectedUpdatedAt, "2026-03-04T05:06:07Z");
  assert.equal(stored.plan.operation.changes.description, "Fresh from file");
  assert.ok(state.calls.some((call) => call.url.includes("/merge_requests/7")), "plan creation reads the live MR");
});

test("force recheck fails when the MR drifted since plan time", async (t) => {
  const root = await fixture(t);
  const drift = mrFetchState(mergeRequestResponse({ updated_at: "2026-02-02T00:00:00Z" }));
  const restoreDrift = drift.install();
  t.after(restoreDrift);
  const { path } = await saveUpdatePlan(root, { sessionId: "other-session", state: "approved" });
  await assert.rejects(applyPlan(root, path, { force: true }), code("PLAN_TARGET_CHANGED"));
});

test("force recheck succeeds when the MR is unchanged and marks forced lifecycle", async (t) => {
  const root = await fixture(t);
  const drift = mrFetchState(mergeRequestResponse());
  const restoreDrift = drift.install();
  t.after(restoreDrift);

  const { path } = await saveUpdatePlan(root, { sessionId: "other-session", state: "approved" });
  const applied = await applyPlan(root, path, { force: true });
  assert.equal(applied.plan.state, "applied");
});

test("force recheck without revision metadata fails closed", async (t) => {
  const root = await fixture(t);
  const state = mrFetchState();
  const restore = state.install();
  t.after(restore);

  const { path } = await saveUpdatePlan(root, {
    sessionId: "other-session", state: "approved",
    operation: {
      kind: "merge_request.update", host: "gitlab.example.test", projectPath: "team/project",
      iid: 7, changes: { description: "Updated body" },
    },
  });
  await assert.rejects(applyPlan(root, path, { force: true }), code("PLAN_TARGET_CHANGED"));
});

test("delegated-only create remains blocked from direct apply", async (t) => {
  const root = await fixture(t);
  const state = mrFetchState();
  const restore = state.install();
  t.after(restore);

  const createdAt = new Date().toISOString();
  const plan = {
    managedBy: "oflow", version: 2, id: randomUUID(), createdAt, updatedAt: createdAt,
    sessionId: process.env.OFLOW_SESSION_ID?.trim() || undefined,
    expiresAt: new Date(Date.parse(createdAt) + PLAN_TTL_MS).toISOString(),
    state: "approved", operation: {
      kind: "merge_request.create", host: "gitlab.example.test", projectPath: "team/project",
      storyIid: 42, sourceBranch: "feature", targetBranch: "main",
      title: "Title", description: "Body",
    },
  };
  const core = Object.fromEntries(
    ["managedBy", "version", "id", "createdAt", "sessionId", "expiresAt", "operation", "sourceAssessment"]
      .map((key) => [key, plan[key]]),
  );
  plan.digest = createHash("sha256").update(JSON.stringify(sorted(core))).digest("hex");
  const path = join(root, PLAN_DIRECTORY, plan.id + ".json");
  await writeFile(path, JSON.stringify(plan));

  await assert.rejects(applyPlan(root, path), code("DELEGATED_ONLY_ACTION"));
});

const { main } = await import("../dist/cli.js");

async function captureMain(args) {
  let out = "";
  let err = "";
  const previousWrite = process.stdout.write.bind(process.stdout);
  const previousErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out += String(chunk); return true; };
  process.stderr.write = (chunk) => { err += String(chunk); return true; };
  try {
    const status = await main(args);
    return { status, out, err };
  } catch (error) {
    return { status: 1, out, err, error };
  } finally {
    process.stdout.write = previousWrite;
    process.stderr.write = previousErr;
  }
}

test("mr update CLI reads --description-file verbatim and writes a plan", async (t) => {
  const root = await fixture(t);
  const descriptionPath = join(root, "mr-description.md");
  const description = [
    "## Acceptance criteria verification",
    "",
    "- [ ] AC-1: multiline preserved",
    "  Evidence: line with trailing  ",
    "",
    "Closes #42",
  ].join("\n");
  await writeFile(descriptionPath, description, "utf8");

  const state = mrFetchState(mergeRequestResponse());
  const restore = state.install();
  t.after(restore);

  const { status, out, err } = await captureMain([
    "mr", "update", "--root", root, "--json",
    "--iid", "7", "--description-file", descriptionPath,
  ]);
  assert.equal(status, 0, err);
  const parsed = JSON.parse(out).plan;
  assert.equal(parsed.operation.kind, "merge_request.update");
  assert.equal(parsed.operation.changes.description, description);
  assert.equal(parsed.operation.changes.title, undefined);

  const planPath = join(root, PLAN_DIRECTORY, parsed.id + ".json");
  const persisted = JSON.parse(await readFile(planPath, "utf8"));
  assert.equal(persisted.operation.changes.description, description);
});

test("mr update CLI rejects --description with --description-file", async (t) => {
  const root = await fixture(t);
  const descriptionPath = join(root, "mr-description.md");
  await writeFile(descriptionPath, "desc", "utf8");
  const state = mrFetchState();
  const restore = state.install();
  t.after(restore);

  const { status, err } = await captureMain([
    "mr", "update", "--root", root, "--iid", "7",
    "--description", "inline", "--description-file", descriptionPath, "--json",
  ]);
  assert.notEqual(status, 0);
  assert.match(err, /not both/);
});

test("mr update CLI rejects a missing description file", async (t) => {
  const root = await fixture(t);
  const state = mrFetchState();
  const restore = state.install();
  t.after(restore);

  const { status, err } = await captureMain([
    "mr", "update", "--root", root, "--iid", "7",
    "--description-file", join(root, "nope.md"), "--json",
  ]);
  assert.notEqual(status, 0);
  assert.match(err, /Description file not found/);
});

test("mr update CLI requires --iid", async (t) => {
  const root = await fixture(t);
  const state = mrFetchState();
  const restore = state.install();
  t.after(restore);

  const { status, err } = await captureMain([
    "mr", "update", "--root", root, "--title", "x", "--json",
  ]);
  assert.notEqual(status, 0);
  assert.match(err, /requires --iid/);
});

test("mr create CLI builds a delegated-only create plan with --description-file", async (t) => {
  const root = await fixture(t);
  const descriptionPath = join(root, "mr-create.md");
  const description = "Line one\n\nLine two\n";
  await writeFile(descriptionPath, description, "utf8");

  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/issues/42")) {
      return new Response(JSON.stringify({ iid: 42, title: "Story title", updated_at: "2026-01-01T00:00:00Z" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/project", default_branch: "main" }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = previous; });

  const { status, out, err } = await captureMain([
    "mr", "create", "--root", root, "--json",
    "--story", "42", "--description-file", descriptionPath,
  ]);
  assert.equal(status, 0, err);
  const parsed = JSON.parse(out).plan;
  assert.equal(parsed.operation.kind, "merge_request.create");
  assert.equal(parsed.operation.changes, undefined);
  assert.equal(parsed.operation.description, description);

  const planPath = join(root, PLAN_DIRECTORY, parsed.id + ".json");
  const persisted = JSON.parse(await readFile(planPath, "utf8"));
  assert.equal(persisted.operation.description, description);
});

test("plan merge-request update CLI path mirrors mr update", async (t) => {
  const root = await fixture(t);
  const state = mrFetchState(mergeRequestResponse());
  const restore = state.install();
  t.after(restore);

  const { status, out, err } = await captureMain([
    "plan", "merge-request", "update", "--root", root, "--json",
    "--iid", "7", "--title", "New title",
  ]);
  assert.equal(status, 0, err);
  const parsed = JSON.parse(out).plan;
  assert.equal(parsed.operation.kind, "merge_request.update");
  assert.equal(parsed.operation.changes.title, "New title");
  assert.equal(parsed.operation.expectedUpdatedAt, "2026-01-01T00:00:00Z");
});
