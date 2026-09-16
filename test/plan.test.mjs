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
  createBulkIssueLabelsPlan,
  createBulkIssuePlanningPlan,
  createIssueCreatePlan,
  createLabelCreatePlan,
  createLabelUpdatePlan,
  createIssueNotePlan,
  createIssueUpdatePlan,
  createBoardCreatePlan,
  createBoardListCreatePlan,
  createBoardListUpdatePlan,
  createBoardUpdatePlan,
  createMilestoneCreatePlan,
  createMilestoneUpdatePlan,
  formatPlanMarkdown,
  verifyPlan,
} from "../dist/plan.js";
import { readAudit } from "../dist/audit.js";

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
    assignees: [],
    due_date: null,
    weight: null,
    epic: null,
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
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "PUT") {
        const body = new URLSearchParams(String(init.body));
        const replacement = body.get("labels");
        const additions = (body.get("add_labels") ?? "").split(",").filter(Boolean);
        const removals = (body.get("remove_labels") ?? "").split(",").filter(Boolean);
        let labels = replacement === null ? [...issue.labels] : replacement.split(",").filter(Boolean);
        for (const label of additions) {
          if (!labels.includes(label)) labels.push(label);
        }
        labels = labels.filter((label) => !removals.includes(label));
        issue = {
          ...issue,
          title: body.get("title") ?? issue.title,
          labels,
          state: body.get("state_event") === "close" ? "closed" : issue.state,
          due_date: body.get("due_date") ?? issue.due_date,
          weight: body.has("weight") ? Number(body.get("weight")) : issue.weight,
          milestone: body.has("milestone_id") && Number(body.get("milestone_id")) === 0
            ? null
            : issue.milestone,
          epic: body.has("epic_id") && Number(body.get("epic_id")) > 0
            ? { id: Number(body.get("epic_id")), iid: 9, title: "Product epic" }
            : null,
          assignees: body.getAll("assignee_ids[]").filter(Boolean).map((id) => ({ id: Number(id), username: Number(id) === 6 ? "alice" : "zakar" })),
        };
      }
      if (url.pathname === "/api/v4/users") {
        const username = url.searchParams.get("username");
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify(username === "alice"
            ? [{ id: 6, username: "alice", name: "Alice" }]
            : [{ id: 5, username: "zakar", name: "Zakar" }]),
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
      due_date: "2027-01-20",
      weight: 3,
      epic_id: 12,
      state_event: "close",
    }, "zakar,alice", {
      generatedAt: "2026-01-01T00:00:00.000Z",
      status: "in-progress",
      recommendations: ["Assign an owner or explicitly confirm why the story is unassigned."],
    });
    assert.equal(created.plan.state, "draft");
    assert.equal(created.plan.sourceAssessment.status, "in-progress");
    assert.match(formatPlanMarkdown(created), /Source assessment: in-progress/);
    assert.deepEqual(created.plan.operation.changes.assignee_ids, [5, 6]);
    assert.equal(created.plan.operation.changes.epic_id, 12);
    const approved = await approvePlan(root, created.path);
    assert.equal(approved.plan.state, "approved");
    const applied = await applyPlan(root, created.path);
    assert.equal(applied.plan.state, "applied");
    const verified = await verifyPlan(root, created.path);
    assert.equal(verified.plan.state, "verified");
    assert.equal(verified.plan.verification.passed, true);

    const cleared = await createIssueUpdatePlan(root, 42, {
      epic_id: 0,
      milestone_id: 0,
    });
    await approvePlan(root, cleared.path);
    await applyPlan(root, cleared.path);
    assert.equal((await verifyPlan(root, cleared.path)).plan.state, "verified");

    const labelDelta = await createIssueUpdatePlan(root, 42, {
      add_labels: "Keep",
      remove_labels: "Ready",
    });
    await approvePlan(root, labelDelta.path);
    await applyPlan(root, labelDelta.path);
    const verifiedLabelDelta = await verifyPlan(root, labelDelta.path);
    assert.equal(verifiedLabelDelta.plan.state, "verified");
    assert.equal(verifiedLabelDelta.plan.verification.passed, true);
    assert.deepEqual(issue.labels.sort(), ["Keep", "User Story"]);

    const audit = await readAudit(root);
    assert.equal(audit.events.length, 12);
    assert.deepEqual(
      audit.events.slice(-4).reverse().map((event) => event.action),
      ["created", "approved", "applied", "verified"],
    );
    assert.equal(audit.events[0].operation.kind, "issue.update");
    assert.deepEqual(audit.events[0].details.fields, ["add_labels", "remove_labels"]);
    assert.ok(!JSON.stringify(audit.events).includes("Choose a pod now"));
    assert.ok(!JSON.stringify(audit.events).includes("secret"));

    const conflict = await createIssueUpdatePlan(root, 42, { title: "Race-safe update" });
    issue.updated_at = "2027-01-01T00:00:00Z";
    await approvePlan(root, conflict.path);
    await assert.rejects(() => applyPlan(root, conflict.path), { code: "PLAN_TARGET_CHANGED" });

    await assert.rejects(
      () => createIssueUpdatePlan(root, 42, {
        labels: "Only",
        add_labels: "Keep",
      }),
      { code: "DUPLICATE_ISSUE_LABELS" },
    );
    await assert.rejects(
      () => createIssueUpdatePlan(root, 42, {
        add_labels: "Keep",
        remove_labels: "Keep",
      }),
      { code: "CONFLICTING_ISSUE_LABELS" },
    );

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

test("bulk issue label plans update every target and verify the shared state", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-bulk-label-plan-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "bulk-label-plan-test-token";
  const issues = new Map([
    [17, { iid: 17, title: "Reserve a pod", labels: ["User Story", "Backlog"], state: "opened" }],
    [18, { iid: 18, title: "Release a pod", labels: ["User Story", "In Progress"], state: "opened" }],
  ]);
  const updates = [];
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
      const iid = Number(url.pathname.split("/").pop());
      const issue = issues.get(iid);
      if (issue === undefined) return response({ message: "not found" });
      if (method === "PUT") {
        const body = new URLSearchParams(String(init.body));
        const added = (body.get("add_labels") ?? "").split(",").map((label) => label.trim()).filter(Boolean);
        const removed = (body.get("remove_labels") ?? "").split(",").map((label) => label.trim()).filter(Boolean);
        issue.labels = [...new Set([...issue.labels, ...added])].filter((label) => !removed.includes(label));
        updates.push({ iid, addLabels: body.get("add_labels"), removeLabels: body.get("remove_labels") });
      }
      return response(issue);
    };

    const created = await createBulkIssueLabelsPlan(root, [17, 18], {
      add_labels: "Ready",
      remove_labels: "Backlog, In Progress",
    });
    assert.equal(created.plan.state, "draft");
    assert.deepEqual(created.plan.operation.issueIids, [17, 18]);
    assert.equal(created.plan.operation.add_labels, "Ready");
    assert.equal(created.plan.operation.remove_labels, "Backlog, In Progress");
    await approvePlan(root, created.path);
    const applied = await applyPlan(root, created.path);
    assert.equal(applied.plan.state, "applied");
    assert.deepEqual(applied.plan.result.issues, [
      { iid: 17, labels: ["User Story", "Ready"] },
      { iid: 18, labels: ["User Story", "Ready"] },
    ]);
    assert.deepEqual(updates, [
      { iid: 17, addLabels: "Ready", removeLabels: "Backlog, In Progress" },
      { iid: 18, addLabels: "Ready", removeLabels: "Backlog, In Progress" },
    ]);
    const verified = await verifyPlan(root, created.path);
    assert.equal(verified.plan.state, "verified");
    assert.equal(verified.plan.verification.passed, true);
    assert.equal(verified.plan.verification.checks.length, 4);

    await assert.rejects(
      () => createBulkIssueLabelsPlan(root, [17], {
        add_labels: "Ready",
        remove_labels: "Ready",
      }),
      { code: "CONFLICTING_ISSUE_LABELS" },
    );
    await assert.rejects(
      () => createBulkIssueLabelsPlan(root, Array.from({ length: 51 }, (_, index) => index + 1), {
        add_labels: "Ready",
      }),
      { code: "TOO_MANY_ISSUES" },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("bulk apply records partial progress and resumes remaining targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-bulk-partial-plan-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "bulk-partial-plan-test-token";
  const issues = new Map([
    [17, { iid: 17, title: "Reserve a pod", labels: ["User Story"], state: "opened", updated_at: undefined }],
    [18, { iid: 18, title: "Release a pod", labels: ["User Story"], state: "opened", updated_at: undefined }],
  ]);
  let failSecond = true;
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
      const iid = Number(url.pathname.split("/").pop());
      const issue = issues.get(iid);
      assert.ok(issue, "unexpected issue request " + url.pathname);
      if ((init?.method ?? "GET") === "PUT" && iid === 18 && failSecond) {
        return {
          ok: false,
          status: 400,
          headers: new Headers(),
          text: async () => JSON.stringify({ message: "temporary failure" }),
        };
      }
      if ((init?.method ?? "GET") === "PUT") {
        const body = new URLSearchParams(String(init.body));
        const added = (body.get("add_labels") ?? "").split(",").filter(Boolean);
        issue.labels = [...new Set([...issue.labels, ...added])];
        if (iid === 17) issue.updated_at = "2027-01-01T00:00:00Z";
      }
      return response(issue);
    };

    const created = await createBulkIssueLabelsPlan(root, [17, 18], { add_labels: "Ready" });
    await approvePlan(root, created.path);
    await assert.rejects(() => applyPlan(root, created.path), { code: "GITLAB_API_ERROR" });
    const partial = JSON.parse(await readFile(created.path, "utf8"));
    assert.equal(partial.state, "approved");
    assert.deepEqual(partial.result.issues, [{ iid: 17, labels: ["User Story", "Ready"] }]);
    assert.deepEqual(partial.applyError, {
      code: "GITLAB_API_ERROR",
      message: "GitLab API 400 for /projects/team%2Fproject/issues/18: {\"message\":\"temporary failure\"}",
      completed: 1,
    });

    failSecond = false;
    const resumed = await applyPlan(root, created.path);
    assert.equal(resumed.plan.state, "applied");
    assert.equal(resumed.plan.applyError, undefined);
    assert.deepEqual(resumed.plan.result.issues, [
      { iid: 17, labels: ["User Story", "Ready"] },
      { iid: 18, labels: ["User Story", "Ready"] },
    ]);
    const audit = await readAudit(root);
    assert.equal(audit.events[0].action, "applied");
    assert.equal(audit.events[1].action, "apply-failed");
    assert.equal(audit.events[1].details.resultCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("bulk planning plans assign owners and milestone timeboxes safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-bulk-planning-plan-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "bulk-planning-plan-test-token";
  const issues = new Map([
    [17, { iid: 17, title: "Reserve a pod", labels: ["User Story"], state: "opened", milestone: null, assignees: [] }],
    [18, { iid: 18, title: "Release a pod", labels: ["User Story"], state: "opened", milestone: null, assignees: [] }],
  ]);
  const updates = [];
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
      if (url.pathname === "/api/v4/users") {
        return response([{ id: 6, username: "alice", name: "Alice" }]);
      }
      const iid = Number(url.pathname.split("/").pop());
      const issue = issues.get(iid);
      if (issue === undefined) return response({ message: "not found" });
      if (method === "PUT") {
        const body = new URLSearchParams(String(init.body));
        if (body.has("milestone")) {
          issue.milestone = { id: 101, title: body.get("milestone") };
        }
        if (body.has("milestone_id") && Number(body.get("milestone_id")) === 0) {
          issue.milestone = null;
        }
        issue.assignees = body.getAll("assignee_ids[]")
          .filter(Boolean)
          .map((id) => ({ id: Number(id), username: "alice" }));
        updates.push({
          iid,
          milestone: body.get("milestone"),
          milestoneId: body.get("milestone_id"),
          assigneeIds: body.getAll("assignee_ids[]"),
        });
      }
      return response(issue);
    };

    const created = await createBulkIssuePlanningPlan(root, [17, 18], {
      milestone: "Sprint 1",
    }, "alice");
    assert.equal(created.plan.state, "draft");
    assert.equal(created.plan.operation.kind, "issues.planning.update");
    assert.deepEqual(created.plan.operation.issueIids, [17, 18]);
    assert.deepEqual(created.plan.operation.changes, {
      milestone: "Sprint 1",
      assignee_ids: [6],
    });
    await approvePlan(root, created.path);
    const applied = await applyPlan(root, created.path);
    assert.equal(applied.plan.state, "applied");
    assert.deepEqual(applied.plan.result.issues, [
      { iid: 17, milestone: "Sprint 1", assigneeIds: [6] },
      { iid: 18, milestone: "Sprint 1", assigneeIds: [6] },
    ]);
    assert.deepEqual(updates, [
      { iid: 17, milestone: "Sprint 1", milestoneId: null, assigneeIds: ["6"] },
      { iid: 18, milestone: "Sprint 1", milestoneId: null, assigneeIds: ["6"] },
    ]);
    const verified = await verifyPlan(root, created.path);
    assert.equal(verified.plan.state, "verified");
    assert.equal(verified.plan.verification.passed, true);
    assert.equal(verified.plan.verification.checks.length, 4);

    await assert.rejects(
      () => createBulkIssuePlanningPlan(root, [17], { due_date: "2027-01-20" }),
      { code: "UNSUPPORTED_BULK_ISSUE_FIELD" },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("issue create plans stay guarded and verify the created work item", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-issue-create-plan-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "issue-create-plan-test-token";
  let issue;
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
      if (url.pathname === "/api/v4/users") {
        return response([{ id: 5, username: "zakar", name: "Zakar" }]);
      }
      if (url.pathname === "/api/v4/projects/team%2Fproject" && method === "GET") {
        return response({ id: 7, path_with_namespace: "team/project", web_url: "https://gitlab.example.test/team/project" });
      }
      if (url.pathname === "/api/v4/projects/team%2Fproject/issues" && method === "POST") {
        const body = new URLSearchParams(String(init.body));
        issue = {
          iid: 77,
          title: body.get("title"),
          description: body.get("description"),
          labels: (body.get("labels") ?? "").split(",").filter(Boolean),
          milestone: { name: body.get("milestone") },
          epic: body.has("epic_id")
            ? { id: Number(body.get("epic_id")), iid: 9, title: "Product epic" }
            : null,
          due_date: body.get("due_date"),
          weight: Number(body.get("weight")),
          assignees: body.getAll("assignee_ids[]").map((id) => ({ id: Number(id), username: "zakar" })),
          state: "opened",
          web_url: "https://gitlab.example.test/team/project/-/issues/77",
        };
        return response(issue);
      }
      if (url.pathname.endsWith("/issues/77")) {
        return response(issue);
      }
      return response({});
    };

    const created = await createIssueCreatePlan(root, {
      title: "Reserve a pod",
      description: "Acceptance criteria:\n- [ ] AC-1: Reservation persists",
      labels: "User Story,Ready",
      milestone: "Sprint 5",
      epic_id: 12,
      due_date: "2027-01-20",
      weight: 3,
    }, "zakar");
    assert.equal(created.plan.state, "draft");
    assert.equal(created.plan.operation.kind, "issue.create");
    assert.deepEqual(created.plan.operation.issue.assignee_ids, [5]);
    assert.equal(created.plan.operation.issue.epic_id, 12);
    await approvePlan(root, created.path);
    const applied = await applyPlan(root, created.path);
    assert.equal(applied.plan.result.iid, 77);
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

test("board and label-backed board-list plans stay guarded and verify remote state", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-board-plan-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "board-plan-test-token";
  const boards = [{ id: 1, name: "Planning" }];
  const labels = [{ id: 5, name: "Ready", color: "#428BCA" }];
  const lists = [{ id: 2, label: { id: 4, name: "In Progress" }, position: 1 }];
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
      const path = url.pathname;
      if (path.endsWith("/boards") && method === "GET") return response(boards);
      if (path.endsWith("/boards") && method === "POST") {
        const body = new URLSearchParams(String(init.body));
        const board = { id: 3, name: body.get("name") };
        boards.push(board);
        return response(board);
      }
      if (path.endsWith("/boards/1") && method === "GET") return response(boards[0]);
      if (/\/boards\/\d+$/.test(path) && method === "GET") {
        const board = boards.find((item) => item.id === Number(path.split("/").pop()));
        return response(board);
      }
      if (path.endsWith("/boards/1") && method === "PUT") {
        const body = new URLSearchParams(String(init.body));
        boards[0].name = body.get("name") ?? boards[0].name;
        return response(boards[0]);
      }
      if (path.endsWith("/labels") && method === "GET") return response(labels);
      if (path.endsWith("/boards/1/lists") && method === "GET") return response(lists);
      if (path.endsWith("/boards/1/lists") && method === "POST") {
        const body = new URLSearchParams(String(init.body));
        const list = { id: 4, label: { id: Number(body.get("label_id")), name: "Ready" }, position: 2 };
        lists.push(list);
        return response(list);
      }
      if (path.endsWith("/boards/1/lists/2") && method === "GET") return response(lists[0]);
      if (path.endsWith("/boards/1/lists/2") && method === "PUT") {
        const body = new URLSearchParams(String(init.body));
        lists[0].position = Number(body.get("position"));
        return response(lists[0]);
      }
      if (path.endsWith("/boards/1/lists/4") && method === "GET") return response(lists[1]);
      return response({});
    };

    const created = await createBoardCreatePlan(root, "Product Backlog");
    await approvePlan(root, created.path);
    const appliedCreate = await applyPlan(root, created.path);
    assert.equal(appliedCreate.plan.result.boardId, 3);
    assert.equal((await verifyPlan(root, created.path)).plan.state, "verified");

    const updated = await createBoardUpdatePlan(root, 1, { name: "Product Planning" });
    await approvePlan(root, updated.path);
    await applyPlan(root, updated.path);
    assert.equal((await verifyPlan(root, updated.path)).plan.state, "verified");

    const listCreated = await createBoardListCreatePlan(root, 1, "Ready");
    await approvePlan(root, listCreated.path);
    const appliedList = await applyPlan(root, listCreated.path);
    assert.equal(appliedList.plan.result.listId, 4);
    assert.equal((await verifyPlan(root, listCreated.path)).plan.state, "verified");

    const listUpdated = await createBoardListUpdatePlan(root, 1, 2, 0);
    await approvePlan(root, listUpdated.path);
    await applyPlan(root, listUpdated.path);
    assert.equal((await verifyPlan(root, listUpdated.path)).plan.state, "verified");
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
