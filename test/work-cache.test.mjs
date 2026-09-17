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
  assignees: ["zakar"],
  startDate: null,
  dueDate: null,
  weight: 3,
  taskCompletion: { completed: 2, total: 6 },
  parent: null,
  updatedAt: "2026-09-17T10:00:00Z",
  webUrl: "https://gitlab.example.test/team/project/-/issues/23",
};

test("SQLite work cache preserves compact assigned work offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-work-cache-"));
  try {
    const query = {
      state: "opened",
      issueLimit: 50,
      issueFilters: {},
      mine: true,
    };
    const saved = await saveWorkItemsCache({
      root,
      host: "gitlab.example.test",
      projectPath: "team/project",
      query,
      actorUsername: "zakar",
      items: [item],
      pagination,
    });
    assert.equal(saved.actorUsername, "zakar");

    const cached = await readWorkItemsCache({
      root,
      host: "gitlab.example.test",
      projectPath: "team/project",
      query,
    });
    assert.equal(cached.cache.source, "sqlite");
    assert.equal(cached.cache.actorUsername, "zakar");
    assert.deepEqual(cached.items, [item]);
    assert.deepEqual(cached.pagination, pagination);
    assert.equal(cached.workItemsMayBeTruncated, false);
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
      },
      actorUsername: "zakar",
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
        },
      }),
      (error) => error?.code === "WORK_CACHE_MISS",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
