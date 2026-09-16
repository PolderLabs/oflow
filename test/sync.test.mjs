import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { formatSyncMarkdown, syncProject } from "../dist/sync.js";

const run = promisify(execFile);

test("sync returns a compact Scrum and delivery snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-sync-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "sync-test-token";
  let pipelineRequests = 0;
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
        ["/api/v4/projects/team%2Fproject/issues", [{ iid: 1, title: "Choose a pod", state: "opened", labels: ["User Story"], description: "Acceptance criteria:\n- [ ] AC-1: Pick a pod", assignees: [], milestone: null, iteration: null, task_completion_status: { count: 3, completed_count: 1 }, parent: { iid: 9, title: "Reservations", web_url: "https://gitlab.example.test/group/-/epics/9" }, updated_at: "2026-01-01T00:00:00Z", web_url: "https://gitlab.example.test/team/project/-/issues/1" }]],
        ["/api/v4/projects/team%2Fproject/issues/1", { iid: 1, title: "Choose a pod", description: "Acceptance criteria:\n- [ ] AC-1: Pick a pod", state: "opened", labels: ["User Story"], task_completion_status: { count: 3, completed_count: 1 }, parent: { iid: 9, title: "Reservations", web_url: "https://gitlab.example.test/group/-/epics/9" }, updated_at: "2026-01-01T00:00:00Z", web_url: "https://gitlab.example.test/team/project/-/issues/1" }],
        ["/api/v4/projects/team%2Fproject/issues/1/notes", [{ id: 4, body: "Blocked on hardware access", author: { username: "zakar" }, created_at: "2026-01-01T00:00:00Z" }]],
        ["/api/v4/projects/team%2Fproject/issues/1/related_merge_requests", [{ iid: 3, title: "Reservation UI", state: "opened", draft: false, source_branch: "story/1", target_branch: "main" }]],
        ["/api/v4/projects/team%2Fproject/merge_requests", [{ iid: 3, title: "Reservation UI", state: "opened", draft: false, source_branch: "story/1", target_branch: "main" }]],
        ["/api/v4/projects/team%2Fproject/pipelines", [{ id: 9, status: "success", ref: "main", sha: "abc" }]],
        ["/api/v4/projects/team%2Fproject/labels", [{ name: "User Story", color: "#fff", open_issues_count: 1 }]],
        ["/api/v4/projects/team%2Fproject/milestones", [{ id: 10, iid: 2, title: "Sprint 1", state: "active", due_date: "2026-01-15" }]],
        ["/api/v4/projects/team%2Fproject/boards", [{ id: 11, name: "Product Backlog" }]],
        ["/api/v4/projects/team%2Fproject/boards/11/lists", [{ id: 12, label: { name: "Ready" }, position: 0 }]],
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
    assert.equal(result.project.path, "team/project");
    assert.equal(result.stats.workItems, 1);
    assert.equal(result.query.issueLimit, 50);
    assert.deepEqual(result.query.issueFilters, {});
    assert.equal(result.workItemsMayBeTruncated, false);
    assert.deepEqual(result.workItems[0].parent, {
      iid: 9,
      title: "Reservations",
      webUrl: "https://gitlab.example.test/group/-/epics/9",
    });
    assert.deepEqual(result.workItems[0].taskCompletion, { completed: 1, total: 3 });
    assert.equal(result.planning.boards[0].lists[0].label, "Ready");
    assert.deepEqual(
      result.planningHealth.findings.map((finding) => finding.code),
      ["unassigned-work-item", "untimeboxed-work-item"],
    );
    assert.equal(result.warnings.length, 0);
    assert.match(formatSyncMarkdown(result), /Open merge requests: 1/);
    assert.doesNotMatch(formatSyncMarkdown(result), /description/);

    const storyResult = await syncProject(root, { storyIid: 1 });
    assert.equal(storyResult.workItemsMayBeTruncated, false);
    assert.equal(pipelineRequests, 2);
    assert.equal(storyResult.story.parent.title, "Reservations");
    assert.deepEqual(storyResult.story.taskCompletion, { completed: 1, total: 3 });
    assert.equal(storyResult.story.notes[0].body, "Blocked on hardware access");
    assert.equal(storyResult.story.recentNotes, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
