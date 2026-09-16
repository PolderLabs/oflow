import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import {
  applyPlan,
  approvePlan,
  createIssueUpdatePlan,
  verifyPlan,
} from "../dist/plan.js";

const run = promisify(execFile);

test("issue update plans require approval and verify the applied result", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-plan-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "plan-test-token";
  let issue = {
    iid: 42,
    title: "Choose a pod",
    description: "Old description",
    state: "opened",
    labels: ["Old"],
    web_url: "https://gitlab.example.test/team/project/-/issues/42",
  };
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    await mkdir(join(root, ".oflow"), { recursive: true });
    await writeFile(
      join(root, ".oflow", "config.json"),
      JSON.stringify({
        managedBy: "oflow",
        version: 1,
        project: { host: "gitlab.example.test", path: "team/project" },
      }),
    );
    globalThis.fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "PUT") {
        const body = new URLSearchParams(String(init.body));
        issue = {
          ...issue,
          title: body.get("title") ?? issue.title,
          labels: (body.get("labels") ?? issue.labels.join(",")).split(","),
          state: body.get("state_event") === "close" ? "closed" : issue.state,
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(issue),
      };
    };

    const created = await createIssueUpdatePlan(root, 42, {
      title: "Choose a pod now",
      labels: "User Story,Ready",
      state_event: "close",
    });
    assert.equal(created.plan.state, "draft");
    const approved = await approvePlan(root, created.path);
    assert.equal(approved.plan.state, "approved");
    const applied = await applyPlan(root, created.path);
    assert.equal(applied.plan.state, "applied");
    const verified = await verifyPlan(root, created.path);
    assert.equal(verified.plan.state, "verified");
    assert.equal(verified.plan.verification.passed, true);

    const stored = JSON.parse(await readFile(created.path, "utf8"));
    stored.operation.changes.title = "tampered";
    await writeFile(created.path, JSON.stringify(stored));
    await assert.rejects(() => approvePlan(root, created.path), { code: "INVALID_PLAN_STATE" });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("plan paths cannot escape the repository plan directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-plan-path-"));
  try {
    await assert.rejects(
      () => approvePlan(root, "/tmp/not-an-oflow-plan.json"),
      { code: "UNSAFE_PLAN_PATH" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
