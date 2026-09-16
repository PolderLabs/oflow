import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import {
  compactSyncSummary,
  formatSyncMarkdown,
  formatSyncSummaryMarkdown,
  syncProject,
} from "../dist/sync.js";

const run = promisify(execFile);

test("sync returns a compact Scrum and delivery snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-sync-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "sync-test-token";
  let pipelineRequests = 0;
  const staleUpdatedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
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

    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      const query = new URL(String(input)).search;
      if (path.endsWith("/pipelines")) pipelineRequests += 1;
      const responses = new Map([
        ["/api/v4/projects/team%2Fproject", { id: 7, path_with_namespace: "team/project", web_url: "https://gitlab.example.test/team/project", default_branch: "main" }],
        ["/api/v4/projects/team%2Fproject/issues", [{ iid: 1, title: "Choose a pod", state: "opened", labels: ["User Story", "Ready", "Doing"], description: "Acceptance criteria:\n- [ ] AC-1: Pick a pod", assignees: [], milestone: null, iteration: null, task_completion_status: { count: 3, completed_count: 1 }, parent: { iid: 9, title: "Reservations", web_url: "https://gitlab.example.test/group/-/epics/9" }, updated_at: staleUpdatedAt, web_url: "https://gitlab.example.test/team/project/-/issues/1" }]],
        ["/api/v4/projects/team%2Fproject/issues/1", { iid: 1, title: "Choose a pod", description: "Acceptance criteria:\n- [ ] AC-1: Pick a pod", state: "opened", labels: ["User Story"], task_completion_status: { count: 3, completed_count: 1 }, parent: { iid: 9, title: "Reservations", web_url: "https://gitlab.example.test/group/-/epics/9" }, updated_at: staleUpdatedAt, web_url: "https://gitlab.example.test/team/project/-/issues/1" }],
        ["/api/v4/projects/team%2Fproject/issues/1/notes", [{ id: 4, body: "Blocked on hardware access", author: { username: "zakar" }, created_at: "2026-01-01T00:00:00Z" }]],
        ["/api/v4/projects/team%2Fproject/issues/1/related_merge_requests", [{ iid: 3, title: "Reservation UI", state: "opened", draft: false, source_branch: "story/1", target_branch: "main" }]],
        ["/api/v4/projects/team%2Fproject/merge_requests", [{ iid: 3, title: "Reservation UI", state: "opened", draft: false, source_branch: "story/1", target_branch: "main" }]],
        ["/api/v4/projects/team%2Fproject/pipelines", [{ id: 9, status: "success", ref: "main", sha: "abc" }]],
        ["/api/v4/projects/team%2Fproject/labels", [{ name: "User Story", color: "#fff", open_issues_count: 1 }]],
        ["/api/v4/projects/team%2Fproject/milestones", [{ id: 10, iid: 2, title: "Sprint 1", state: "active", due_date: "2026-01-15" }]],
        ["/api/v4/projects/team%2Fproject/boards", [{ id: 11, name: "Product Backlog" }]],
        ["/api/v4/projects/team%2Fproject/boards/11/lists", [{ id: 12, label: { name: "Ready" }, position: 0 }, { id: 13, label: { name: "Doing" }, position: 1 }]],
        ["/api/v4/projects/team%2Fproject/iterations", []],
      ]);
      const response = responses.get(path);
      assert.ok(response, "unexpected request " + path + query);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(response),
      };
    };

    const result = await syncProject(root);
    assert.equal(result.cache.source, "remote");
    assert.equal(result.cache.ageSeconds, 0);
    const cacheText = await readFile(join(root, ".oflow", "cache", "sync.json"), "utf8");
    assert.match(cacheText, /"version": 1/);
    assert.ok(!cacheText.includes("sync-test-token"));
    assert.equal(result.project.path, "team/project");
    assert.equal(result.stats.workItems, 1);
    assert.equal(result.query.issueLimit, 50);
    assert.equal(result.query.staleDays, null);
    assert.deepEqual(result.query.issueFilters, {});
    assert.equal(result.workItemsMayBeTruncated, false);
    assert.equal(result.pagination.workItems.returned, 1);
    assert.equal(result.pagination.workItems.requested, 50);
    assert.equal(result.pagination.workItems.hasNextPage, false);
    assert.equal(result.pagination.mergeRequests.hasNextPage, false);
    assert.equal(result.pagination.boardLists[0].boardId, 11);
    assert.deepEqual(result.workItems[0].parent, {
      iid: 9,
      title: "Reservations",
      webUrl: "https://gitlab.example.test/group/-/epics/9",
    });
    assert.deepEqual(result.workItems[0].taskCompletion, { completed: 1, total: 3 });
    assert.equal(result.planning.boards[0].lists[0].label, "Ready");
    assert.deepEqual(
      result.planningHealth.findings.map((finding) => finding.code),
      ["unassigned-work-item", "untimeboxed-work-item", "conflicting-board-labels"],
    );
    assert.equal(result.warnings.length, 0);
    assert.match(formatSyncMarkdown(result), /Open merge requests: 1/);
    assert.doesNotMatch(formatSyncMarkdown(result), /description/);
    const summary = compactSyncSummary(result);
    assert.equal(summary.pagination, undefined);
    assert.deepEqual(summary.planning.labels, ["User Story"]);
    assert.equal(summary.workItems[0].taskCompletion.completed, 1);
    assert.match(formatSyncSummaryMarkdown(summary), /# oflow sync summary/);
    assert.match(formatSyncSummaryMarkdown(summary), /1 open work item has no assignee/);

    const storyResult = await syncProject(root, { storyIid: 1 });
    assert.equal(storyResult.workItemsMayBeTruncated, false);
    assert.equal(pipelineRequests, 2);
    assert.equal(storyResult.story.parent.title, "Reservations");
    assert.deepEqual(storyResult.story.taskCompletion, { completed: 1, total: 3 });
    assert.equal(storyResult.story.notes[0].body, "Blocked on hardware access");
    assert.equal(storyResult.story.recentNotes, 1);
    const storySummary = compactSyncSummary(storyResult);
    assert.deepEqual(storySummary.story, {
      iid: 1,
      title: "Choose a pod",
      state: "opened",
      labels: ["User Story"],
      milestone: null,
      iteration: null,
      assignees: [],
      taskCompletion: { completed: 1, total: 3 },
      acceptanceCriteria: 1,
      mergeRequests: 1,
      pipelines: 1,
      recentNotes: 1,
      webUrl: "https://gitlab.example.test/team/project/-/issues/1",
    });

    const staleResult = await syncProject(root, { staleDays: 1 });
    assert.equal(staleResult.query.staleDays, 1);
    assert.deepEqual(
      staleResult.planningHealth.findings.find((finding) => finding.code === "stale-work-item"),
      {
        code: "stale-work-item",
        message: "1 work item has not changed in the last 1 day",
        storyIids: [1],
      },
    );

    const cachedResult = await syncProject(root, { cache: "cached", staleDays: 1 });
    assert.equal(cachedResult.cache.source, "cache");
    assert.equal(cachedResult.generatedAt, staleResult.generatedAt);
    assert.equal(pipelineRequests, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("cached sync refuses to use a missing snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-sync-cache-miss-"));
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
    await assert.rejects(
      () => syncProject(root, { cache: "cached" }),
      (error) => error?.code === "SYNC_CACHE_MISS",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sync reads group epics only when explicitly requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-sync-epics-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "sync-epics-test-token";
  const requests = [];
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
      requests.push({ path: url.pathname, method: init?.method ?? "GET" });
      if (url.pathname === "/api/graphql") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({
            data: {
              group: {
                workItems: {
                  nodes: [{
                    id: "gid://gitlab/WorkItem/9",
                    iid: "4",
                    title: "Reservations",
                    state: "OPENED",
                    webUrl: "https://gitlab.example.test/groups/team/-/epics/4",
                  }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          }),
        };
      }
      const responses = new Map([
        ["/api/v4/projects/team%2Fproject", {
          id: 7,
          path_with_namespace: "team/project",
          web_url: "https://gitlab.example.test/team/project",
          namespace: { full_path: "team" },
        }],
        ["/api/v4/projects/team%2Fproject/issues", []],
        ["/api/v4/projects/team%2Fproject/merge_requests", []],
        ["/api/v4/projects/team%2Fproject/pipelines", []],
        ["/api/v4/projects/team%2Fproject/labels", []],
        ["/api/v4/projects/team%2Fproject/milestones", []],
        ["/api/v4/projects/team%2Fproject/boards", []],
        ["/api/v4/projects/team%2Fproject/iterations", []],
      ]);
      const response = responses.get(url.pathname);
      assert.ok(response, "unexpected request " + url.pathname);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(response),
      };
    };

    const normal = await syncProject(root);
    assert.equal(normal.query.includeEpics, false);
    assert.deepEqual(normal.planning.epics, []);
    assert.equal(requests.some((request) => request.path === "/api/graphql"), false);

    const withEpics = await syncProject(root, { includeEpics: true });
    assert.equal(withEpics.query.includeEpics, true);
    assert.deepEqual(withEpics.planning.epics, [{
      iid: 4,
      title: "Reservations",
      state: "OPENED",
      webUrl: "https://gitlab.example.test/groups/team/-/epics/4",
    }]);
    assert.equal(withEpics.planning.epicsMayBeTruncated, false);
    assert.equal(withEpics.stats.epics, 1);
    assert.equal(requests.filter((request) => request.path === "/api/graphql").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
