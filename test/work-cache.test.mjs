import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  readWorkItemsCache,
  saveWorkItemsCache,
} from "../dist/work-cache.js";

const pagination = {
  returned: 1,
  requested: 50,
  page: 1,
  nextPage: null,
  total: 1,
  totalPages: 1,
  hasNextPage: false,
};

const item = {
  iid: 23,
  title: "Verify the supported XLOCK integration path",
  state: "opened",
  labels: ["User Story", "In Progress"],
  milestone: "Sprint 1",
  iteration: "Iteration 1",
  assignees: ["test-user"],
  startDate: null,
  dueDate: null,
  weight: 3,
  taskCompletion: { completed: 2, total: 6 },
  parent: null,
  updatedAt: "2026-09-17T10:00:00Z",
  webUrl: "https://gitlab.example.test/team/project/-/issues/23",
};

test("SQLite work cache preserves compact assigned work for the same actor", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-work-cache-"));
  try {
    const query = {
      state: "opened",
      issueLimit: 50,
      issueFilters: {},
      mine: true,
      actorId: 7,
    };
    const saved = await saveWorkItemsCache({
      root,
      host: "gitlab.example.test",
      projectPath: "team/project",
      query,
      actorId: 7,
      actorUsername: "test-user",
      items: [item],
      pagination,
    });
    assert.equal(saved.actorId, 7);
    assert.equal(saved.actorUsername, "test-user");

    const cached = await readWorkItemsCache({
      root,
      host: "gitlab.example.test",
      projectPath: "team/project",
      query,
    });
    assert.equal(cached.cache.source, "sqlite");
    assert.equal(cached.cache.actorId, 7);
    assert.equal(cached.cache.actorUsername, "test-user");
    assert.deepEqual(cached.items, [item]);
    assert.deepEqual(cached.pagination, pagination);
    assert.equal(cached.workItemsMayBeTruncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite work cache refuses an assigned-work snapshot owned by another actor", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-work-cache-actor-"));
  try {
    const query = { state: "opened", issueLimit: 50, issueFilters: {}, mine: true, actorId: 7 };
    await saveWorkItemsCache({
      root, host: "gitlab.example.test", projectPath: "team/project", query,
      actorId: 7, actorUsername: "test-user", items: [item], pagination,
    });
    await assert.rejects(
      () => readWorkItemsCache({
        root, host: "gitlab.example.test", projectPath: "team/project",
        query,
        expectedActorId: 8,
      }),
      (error) => error?.code === "WORK_CACHE_IDENTITY_MISMATCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite work cache rejects a legacy assigned-work snapshot without actor ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-work-cache-legacy-"));
  try {
    const query = { state: "opened", issueLimit: 50, issueFilters: {}, mine: true, actorId: 7 };
    await saveWorkItemsCache({
      root, host: "gitlab.example.test", projectPath: "team/project", query,
      actorId: 7, actorUsername: "test-user", items: [item], pagination,
    });
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(root, ".oflow", "cache", "oflow.db"));
    database.prepare("UPDATE work_item_cache_queries SET actor_id = NULL").run();
    database.close();
    await assert.rejects(
      () => readWorkItemsCache({
        root, host: "gitlab.example.test", projectPath: "team/project", query,
        expectedActorId: 7,
      }),
      (error) => error?.code === "WORK_CACHE_IDENTITY_MISMATCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite work cache rejects a genuine pre-v3 cache without the actor_id column", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-work-cache-nov3-"));
  try {
    await saveWorkItemsCache({
      root, host: "gitlab.example.test", projectPath: "team/project",
      query: { state: "opened", issueLimit: 50, issueFilters: {}, mine: true, actorId: 7 },
      actorId: 7, actorUsername: "test-user", items: [item], pagination,
    });
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(root, ".oflow", "cache", "oflow.db"));
    database.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE work_item_cache_queries RENAME TO work_item_cache_queries_v3;
      CREATE TABLE work_item_cache_queries (
        cache_key TEXT PRIMARY KEY, project_key TEXT NOT NULL, query_json TEXT NOT NULL,
        state TEXT NOT NULL, issue_limit INTEGER NOT NULL, mine INTEGER NOT NULL,
        actor_username TEXT, saved_at TEXT NOT NULL,
        work_items_may_be_truncated INTEGER NOT NULL, pagination_json TEXT NOT NULL
      );
      INSERT INTO work_item_cache_queries
        SELECT cache_key, project_key, query_json, state, issue_limit, mine,
               actor_username, saved_at, work_items_may_be_truncated, pagination_json
        FROM work_item_cache_queries_v3;
      DROP TABLE work_item_cache_queries_v3;
      UPDATE oflow_meta SET value = '2' WHERE key = 'schema_version';
      PRAGMA foreign_keys = ON;
    `);
    database.close();
    await assert.rejects(
      () => readWorkItemsCache({
        root, host: "gitlab.example.test", projectPath: "team/project",
        query: { state: "opened", issueLimit: 50, issueFilters: {}, mine: true, actorId: 7 },
      }),
      (error) => error?.code === "WORK_CACHE_IDENTITY_UNAVAILABLE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite work cache preserves legacy non-mine keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-work-cache-non-mine-"));
  try {
    const query = { state: "opened", issueLimit: 50, issueFilters: {}, mine: false, actorId: null };
    await saveWorkItemsCache({
      root, host: "gitlab.example.test", projectPath: "team/project", query,
      actorId: null, actorUsername: null, items: [item], pagination,
    });
    const cached = await readWorkItemsCache({
      root, host: "gitlab.example.test", projectPath: "team/project", query,
    });
    assert.deepEqual(cached.items, [item]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite work cache refuses a different query instead of returning stale data silently", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-work-cache-query-"));
  try {
    await saveWorkItemsCache({
      root,
      host: "gitlab.example.test",
      projectPath: "team/project",
      query: {
        state: "opened",
        issueLimit: 50,
        issueFilters: {},
        mine: true,
        actorId: 7,
      },
      actorId: 7,
      actorUsername: "test-user",
      items: [item],
      pagination,
    });
    await assert.rejects(
      () => readWorkItemsCache({
        root,
        host: "gitlab.example.test",
        projectPath: "team/project",
        query: {
          state: "opened",
          issueLimit: 20,
          issueFilters: {},
          mine: true,
          actorId: 7,
        },
      }),
      (error) => error?.code === "WORK_CACHE_MISS",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
