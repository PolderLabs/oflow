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
          source_branch: "story/1",
          target_branch: "main",
          web_url: "https://gitlab.example.test/team/project/-/merge_requests/3",
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
    assert.deepEqual(result.story.taskCompletion, { completed: 1, total: 4 });
    assert.ok(result.nextActions.includes("Assign an owner or explicitly confirm why the story is unassigned."));
    assert.ok(result.nextActions.includes("Assign a milestone or iteration before sprint commitment."));
    assert.equal(result.local.clean, false);
    assert.ok(result.local.changedFiles.includes("README.md"));
    assert.match(formatAssessmentMarkdown(result), /Status: satisfied/);
    assert.match(formatAssessmentMarkdown(result), /Changed files: 1/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
