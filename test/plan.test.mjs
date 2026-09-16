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
  createLabelCreatePlan,
  createLabelUpdatePlan,
  createIssueNotePlan,
  createIssueUpdatePlan,
  createMilestoneCreatePlan,
  createMilestoneUpdatePlan,
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

test("issue note plans create a note once and verify its body", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-note-plan-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "note-plan-test-token";
  let nextNoteId = 10;
  const notes = [];
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
      const url = new URL(String(input));
      if (url.pathname.endsWith("/notes") && (init?.method ?? "GET") === "POST") {
        const body = new URLSearchParams(String(init.body)).get("body");
        const note = { id: nextNoteId++, body, noteable_iid: 42 };
        notes.unshift(note);
        return response(note);
      }
      if (url.pathname.endsWith("/notes")) {
        return response(notes);
      }
      return response({
        iid: 42,
        title: "Choose a pod",
        state: "opened",
        labels: [],
        web_url: "https://gitlab.example.test/team/project/-/issues/42",
      });
    };

    const created = await createIssueNotePlan(root, 42, "Progress: API contract confirmed.");
    await approvePlan(root, created.path);
    const applied = await applyPlan(root, created.path);
    assert.equal(applied.plan.state, "applied");
    assert.equal(applied.plan.result.noteId, 10);
    await assert.rejects(() => applyPlan(root, created.path), { code: "INVALID_PLAN_STATE" });
    const verified = await verifyPlan(root, created.path);
    assert.equal(verified.plan.state, "verified");
    assert.equal(verified.plan.verification.passed, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("plans bind the GitLab host before applying", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-plan-host-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "host-plan-test-token";
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
    globalThis.fetch = async () => response({ iid: 42, title: "Choose a pod", state: "opened" });
    const created = await createIssueUpdatePlan(root, 42, { title: "Updated" });
    await approvePlan(root, created.path);
    await run("git", ["-C", root, "remote", "set-url", "origin", "git@other.example.test:team/project.git"]);
    await assert.rejects(() => applyPlan(root, created.path), { code: "PLAN_TARGET_MISMATCH" });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("label plans create and update labels through approval and verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-label-plan-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "label-plan-test-token";
  let nextLabelId = 7;
  const labels = [{ id: 1, name: "Backlog", color: "#666666", description: "Unstarted" }];
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
      const url = new URL(String(input));
      if (url.pathname.endsWith("/labels") && (init?.method ?? "GET") === "POST") {
        const body = new URLSearchParams(String(init.body));
        const label = {
          id: nextLabelId++,
          name: body.get("name"),
          color: body.get("color"),
          description: body.get("description") ?? null,
        };
        labels.push(label);
        return response(label);
      }
      if (url.pathname.includes("/labels/") && (init?.method ?? "GET") === "PUT") {
        const id = Number(decodeURIComponent(url.pathname.split("/").pop()));
        const label = labels.find((item) => item.id === id);
        const body = new URLSearchParams(String(init.body));
        Object.assign(label, {
          name: body.get("new_name") ?? label.name,
          color: body.get("color") ?? label.color,
          description: body.has("description") ? body.get("description") : label.description,
        });
        return response(label);
      }
      return response(labels);
    };

    const created = await createLabelCreatePlan(root, {
      name: "Ready",
      color: "#428BCA",
      description: "Ready for implementation",
    });
    await approvePlan(root, created.path);
    const appliedCreate = await applyPlan(root, created.path);
    assert.equal(appliedCreate.plan.result.name, "Ready");
    const verifiedCreate = await verifyPlan(root, created.path);
    assert.equal(verifiedCreate.plan.verification.passed, true);

    const updated = await createLabelUpdatePlan(root, "Ready", {
      new_name: "In progress",
      color: "#36A269",
    });
    await approvePlan(root, updated.path);
    await applyPlan(root, updated.path);
    const verifiedUpdate = await verifyPlan(root, updated.path);
    assert.equal(verifiedUpdate.plan.state, "verified");
    assert.equal(verifiedUpdate.plan.verification.passed, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("milestone plans create and update timeboxes through approval and verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-milestone-plan-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "milestone-plan-test-token";
  const milestones = [];
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
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/milestones") && method === "POST") {
        const body = new URLSearchParams(String(init.body));
        const milestone = {
          id: 51,
          iid: 5,
          title: body.get("title"),
          description: body.get("description") ?? null,
          start_date: body.get("start_date") ?? null,
          due_date: body.get("due_date") ?? null,
          state: "active",
        };
        milestones.push(milestone);
        return response(milestone);
      }
      if (url.pathname.endsWith("/milestones/5") && method === "PUT") {
        const milestone = milestones.find((item) => item.iid === 5);
        const body = new URLSearchParams(String(init.body));
        Object.assign(milestone, {
          title: body.get("title") ?? milestone.title,
          due_date: body.get("due_date") ?? milestone.due_date,
          state: body.get("state_event") === "close" ? "closed" : milestone.state,
        });
        return response(milestone);
      }
      if (url.pathname.endsWith("/milestones/5")) {
        return response(milestones.find((item) => item.iid === 5));
      }
      return response(milestones);
    };

    const created = await createMilestoneCreatePlan(root, {
      title: "Sprint 5",
      start_date: "2027-01-11",
      due_date: "2027-01-31",
    });
    await approvePlan(root, created.path);
    const appliedCreate = await applyPlan(root, created.path);
    assert.equal(appliedCreate.plan.result.milestoneIid, 5);
    const verifiedCreate = await verifyPlan(root, created.path);
    assert.equal(verifiedCreate.plan.verification.passed, true);

    const updated = await createMilestoneUpdatePlan(root, 5, {
      title: "Sprint 5 - closed",
      state_event: "close",
    });
    await approvePlan(root, updated.path);
    await applyPlan(root, updated.path);
    const verifiedUpdate = await verifyPlan(root, updated.path);
    assert.equal(verifiedUpdate.plan.state, "verified");
    assert.equal(verifiedUpdate.plan.verification.passed, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

function response(value) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(value),
  };
}
