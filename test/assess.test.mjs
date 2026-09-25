import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { assessStory, formatAssessmentMarkdown } from "../dist/assess.js";

const run = promisify(execFile);

test("assess combines explicit MR evidence with compact local repository evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-assess-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "assess-test-token";
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "config", "user.email", "test@example.test"]);
    await run("git", ["-C", root, "config", "user.name", "Test User"]);
    await writeFile(join(root, "README.md"), "initial\n");
    await run("git", ["-C", root, "add", "README.md"]);
    await run("git", ["-C", root, "commit", "-qm", "initial"]);
    await run("git", ["-C", root, "checkout", "-qb", "story/1"]);
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
    await run("git", ["-C", root, "add", ".oflow/config.json"]);
    await run("git", ["-C", root, "commit", "-qm", "configure oflow"]);
    await writeFile(join(root, "README.md"), "local change\n");
    await mkdir(join(root, "test"), { recursive: true });
    await writeFile(join(root, "test", "pod.test.ts"), 'test("AC-1 picks a pod", () => {});\n');

    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      const responses = new Map([
        ["/api/v4/projects/team%2Fproject", { id: 7, path_with_namespace: "team/project", web_url: "https://gitlab.example.test/team/project" }],
        ["/api/v4/projects/team%2Fproject/issues/1", {
          iid: 1,
          title: "Choose a pod",
          description: "Acceptance criteria:\n- [ ] AC-1: Pick a pod",
          issue_type: "issue",
          state: "opened",
          labels: ["User Story"],
          assignees: [],
          milestone: null,
          iteration: null,
          task_completion_status: { count: 4, completed_count: 1 },
          weight: 2,
          web_url: "https://gitlab.example.test/team/project/-/issues/1",
        }],
        ["/api/v4/projects/team%2Fproject/issues/1/notes", []],
        ["/api/v4/projects/team%2Fproject/issues/1/related_merge_requests", [{
          iid: 3,
          title: "Pick a pod",
          description: "## Acceptance criteria verification\n\n- [x] AC-1: Pick a pod\n  Evidence: unit test passes",
          state: "opened",
          draft: false,
          sha: "story-1-sha",
          source_branch: "story/1",
          target_branch: "main",
          web_url: "https://gitlab.example.test/team/project/-/merge_requests/3",
        }]],
        ["/api/v4/projects/team%2Fproject/merge_requests/3/pipelines", [{
          id: 10,
          status: "success",
          ref: "refs/merge-requests/3/head",
          sha: "story-1-sha",
          web_url: "https://gitlab.example.test/team/project/-/pipelines/10",
        }]],
        ["/api/v4/projects/team%2Fproject/pipelines", [{ id: 9, status: "success", ref: "story/1", web_url: "https://gitlab.example.test/team/project/-/pipelines/9" }]],
      ]);
      const response = responses.get(path);
      assert.ok(response, "unexpected request " + path);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(response),
      };
    };

    const result = await assessStory(root, 1);
    assert.equal(result.status, "satisfied");
    assert.equal(result.criteria[0].status, "satisfied");
    assert.equal(result.remote.mergeRequest.iid, 3);
    assert.deepEqual(result.story.assignees, []);
    assert.ok("issueType" in result.story);
    assert.ok(["issue", "task", "incident", "test_case"].includes(result.story.issueType));
    assert.ok(result.nextActions.includes("Assign an owner or explicitly confirm why the story is unassigned."));
    assert.ok(result.nextActions.includes("Assign a milestone or iteration before sprint commitment."));
    assert.equal(result.local.clean, false);
    assert.ok(result.local.changedFiles.includes("README.md"));
    assert.deepEqual(result.criteria[0].localReferences, [
      { kind: "test", path: "test/pod.test.ts", line: 1 },
    ]);
    assert.equal("criteria" in result.local, false);
    assert.match(formatAssessmentMarkdown(result), /Status: satisfied/);
    assert.match(formatAssessmentMarkdown(result), /Changed files: 2/);
    assert.match(formatAssessmentMarkdown(result), /local references: 1/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("assess does not use an unrelated successful branch pipeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-assess-pipeline-binding-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "assess-pipeline-binding-token";
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "checkout", "-qb", "story/1"]);
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
    // F4: with CI config present, a missing MR-bound pipeline must still block.
    await writeFile(join(root, ".gitlab-ci.yml"), "test:\n  script:\n    - npm test\n");

    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      const responses = new Map([
        ["/api/v4/projects/team%2Fproject", { id: 7, path_with_namespace: "team/project", web_url: "https://gitlab.example.test/team/project" }],
        ["/api/v4/projects/team%2Fproject/issues/1", {
          iid: 1,
          title: "Choose a pod",
          description: "Acceptance criteria:\n- [ ] AC-1: Pick a pod",
          state: "opened",
          labels: ["User Story"],
          assignees: [{ username: "test-user" }],
          milestone: { title: "Sprint 1" },
          sha: undefined,
          web_url: "https://gitlab.example.test/team/project/-/issues/1",
        }],
        ["/api/v4/projects/team%2Fproject/issues/1/notes", []],
        ["/api/v4/projects/team%2Fproject/issues/1/related_merge_requests", [{
          iid: 3,
          title: "Pick a pod",
          description: "## Acceptance criteria verification\n\n- [x] AC-1: Pick a pod\n  Evidence: unit test passes",
          state: "opened",
          draft: false,
          sha: "current-mr-head",
          source_branch: "story/other",
          target_branch: "main",
          web_url: "https://gitlab.example.test/team/project/-/merge_requests/3",
        }]],
        ["/api/v4/projects/team%2Fproject/pipelines", [{
          id: 9,
          status: "success",
          ref: "story/1",
          sha: "unrelated-branch-head",
          web_url: "https://gitlab.example.test/team/project/-/pipelines/9",
        }]],
        ["/api/v4/projects/team%2Fproject/merge_requests/3/pipelines", [{
          id: 10,
          status: "success",
          ref: "refs/merge-requests/3/head",
          sha: "old-mr-head",
          web_url: "https://gitlab.example.test/team/project/-/pipelines/10",
        }]],
      ]);
      const response = responses.get(path);
      assert.ok(response, "unexpected request " + path);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(response),
      };
    };

    const result = await assessStory(root, 1);
    assert.notEqual(result.status, "satisfied");
    assert.equal(result.remote.mergeRequest.iid, 3);
    assert.equal(result.remote.pipeline, null);
    assert.match(result.warnings.join("\n"), /No merge request pipeline matches the selected merge request head SHA/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
