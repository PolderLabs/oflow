import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  markReadModelStale,
  readDashboardData,
  readReadModelStatus,
  requestReadModelRefresh,
  saveSyncReadModel,
} from "../dist/read-model.js";
import { startDashboard } from "../dist/dashboard.js";

function snapshot() {
  return {
    generatedAt: "2026-09-17T10:00:00.000Z",
    cache: { source: "remote", savedAt: "2026-09-17T10:00:00.000Z", ageSeconds: 0 },
    project: { id: 7, path: "team/project", webUrl: "https://gitlab.example.test/team/project", defaultBranch: "main" },
    repository: { branch: "main", groupPath: "team" },
    workItems: [{
      iid: 1,
      title: "Plan the next increment",
      state: "opened",
      labels: ["User Story"],
      milestone: "Sprint 1",
      iteration: "Iteration 1",
      assignees: ["test-user"],
      startDate: null,
      dueDate: null,
      weight: 2,
      taskCompletion: { completed: 1, total: 2 },
      parent: null,
      updatedAt: "2026-09-17T09:00:00.000Z",
      webUrl: "https://gitlab.example.test/team/project/-/issues/1",
    }],
    workItemsMayBeTruncated: false,
    query: { state: "opened", issueLimit: 50, issueFilters: {}, includeEpics: false, staleDays: null },
    mergeRequests: [{
      iid: 2,
      title: "Implement the increment",
      state: "opened",
      draft: true,
      sourceBranch: "story/1",
      targetBranch: "main",
      updatedAt: "2026-09-17T09:30:00.000Z",
      webUrl: "https://gitlab.example.test/team/project/-/merge_requests/2",
    }],
    pipelines: [{ id: 3, status: "success", ref: "main", sha: "abc", updatedAt: "2026-09-17T09:40:00.000Z", webUrl: null }],
    planning: {
      labels: [{ name: "User Story", color: "#ffffff", openIssues: 1, closedIssues: 0, openMergeRequests: 0 }],
      milestones: [{ iid: 4, title: "Sprint 1", state: "active", startDate: null, dueDate: "2026-09-24", webUrl: null }],
      boards: [{ id: 5, name: "Product Backlog", lists: [{ id: 6, label: "Ready", position: 0 }] }],
      iterations: [{ iid: 7, title: "Iteration 1", state: "current", startDate: "2026-09-17", dueDate: "2026-09-24", webUrl: null }],
      epics: [],
      epicsMayBeTruncated: false,
    },
    pagination: {
      workItems: { returned: 1, requested: 50, page: 1, nextPage: null, total: 1, totalPages: 1, hasNextPage: false },
      mergeRequests: { returned: 1, requested: 20, page: 1, nextPage: null, total: 1, totalPages: 1, hasNextPage: false },
      pipelines: { returned: 1, requested: 10, page: 1, nextPage: null, total: 1, totalPages: 1, hasNextPage: false },
      labels: { returned: 1, requested: 100, page: 1, nextPage: null, total: 1, totalPages: 1, hasNextPage: false },
      milestones: { returned: 1, requested: 100, page: 1, nextPage: null, total: 1, totalPages: 1, hasNextPage: false },
      boards: { returned: 1, requested: 100, page: 1, nextPage: null, total: 1, totalPages: 1, hasNextPage: false },
      boardLists: [{ boardId: 5, pagination: { returned: 1, requested: 100, page: 1, nextPage: null, total: 1, totalPages: 1, hasNextPage: false } }],
      iterations: { returned: 1, requested: 100, page: 1, nextPage: null, total: 1, totalPages: 1, hasNextPage: false },
      epics: { returned: 0, requested: 50, page: 1, nextPage: null, total: 0, totalPages: 1, hasNextPage: false },
    },
    story: null,
    stats: { workItems: 1, mergeRequests: 1, pipelines: 1, labels: 1, milestones: 1, boards: 1, iterations: 1, epics: 0 },
    planningHealth: { findings: [] },
    warnings: [],
  };
}

test("sync read model stores planning, delivery, history, and diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-read-model-"));
  try {
    await saveSyncReadModel({ root, host: "gitlab.example.test", projectPath: "team/project", result: snapshot() });
    const status = await readReadModelStatus(root);
    assert.equal(status.state, "ready");
    assert.equal(status.schemaVersion, 3);
    assert.equal(status.latestSync.stats.workItems, 1);
    assert.deepEqual(status.counts, {
      workItems: 1,
      mergeRequests: 1,
      pipelines: 1,
      iterations: 1,
      syncSnapshots: 1,
    });

    const data = await readDashboardData(root);
    assert.equal(data.workItems[0].iid, 1);
    assert.equal(data.mergeRequests[0].iid, 2);
    assert.equal(data.pipelines[0].status, "success");
    assert.equal(data.iterations[0].title, "Iteration 1");
    assert.equal(data.syncHistory.length, 1);
    assert.equal(await requestReadModelRefresh(root), true);
    assert.equal((await readReadModelStatus(root)).refreshRequest.reason, "dashboard");
    assert.equal(await markReadModelStale(root, "test invalidation"), true);
    const stale = await readReadModelStatus(root);
    assert.equal(stale.invalidation.reason, "test invalidation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard is loopback-only, read-only for GitLab, and has explicit refresh boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-dashboard-"));
  const dashboard = await startDashboard(root, { port: 0 });
  try {
    assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /oflow cockpit/);

    const status = await fetch(new URL("api/status", dashboard.url));
    assert.equal(status.status, 200);
    assert.equal((await status.json()).state, "missing");

    const refresh = await fetch(new URL("api/refresh", dashboard.url), { method: "POST" });
    assert.equal(refresh.status, 202);
    assert.equal((await refresh.json()).credentialsExposed, false);
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy SQLite schema is diagnosed and migrated by the next live sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-read-model-migration-"));
  try {
    await saveSyncReadModel({ root, host: "gitlab.example.test", projectPath: "team/project", result: snapshot() });
    const database = new DatabaseSync(join(root, ".oflow", "cache", "oflow.db"));
    // Pre-version-3 caches (no actor_id column) simulate an installed v0.3.0 database.
    database.prepare("UPDATE oflow_meta SET value = '1' WHERE key = 'schema_version'").run();
    database.close();
    assert.equal((await readReadModelStatus(root)).state, "migration-required");

    await saveSyncReadModel({ root, host: "gitlab.example.test", projectPath: "team/project", result: snapshot() });
    assert.equal((await readReadModelStatus(root)).state, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
