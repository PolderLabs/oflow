import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { startWork, checkStory } from "../dist/lifecycle.js";

const run = promisify(execFile);

async function initStoryRepo(root) {
  await run("git", ["init", "-q", root]);
  await run("git", ["-C", root, "config", "user.email", "test@example.test"]);
  await run("git", ["-C", root, "config", "user.name", "Test User"]);
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
}

function gitlabFetchStub() {
  return async (input) => {
    const url = new URL(String(input));
    const path = url.pathname + (url.search || "");
    const json = (body) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
      headers: new Headers(),
    });
    if (path.startsWith("/api/v4/user")) {
      return json({ id: 5, username: "ada" });
    }
    if (path.startsWith("/api/v4/projects/team%2Fproject/issues?") || path === "/api/v4/projects/team%2Fproject/issues") {
      return json([
        {
          iid: 42,
          title: "Synchronize meeting-room occupancy",
          state: "opened",
          web_url: "https://gitlab.example.test/team/project/-/issues/42",
          labels: ["In Progress"],
          assignees: [{ username: "ada" }],
          description: "## Acceptance criteria\n\n- [ ] AC1: Occupied state updates\n- [ ] AC2: Vacant transition propagates\n",
        },
      ]);
    }
    if (path.startsWith("/api/v4/projects/team%2Fproject/issues/42/notes")) {
      return json([]);
    }
    if (
      path.startsWith("/api/v4/projects/team%2Fproject/issues/42/related_merge_requests") ||
      path.startsWith("/api/v4/projects/team%2Fproject/merge_requests") ||
      path.startsWith("/api/v4/projects/team%2Fproject/pipelines")
    ) {
      return json([]);
    }
    if (path === "/api/v4/projects/team%2Fproject/issues/42") {
      return json({
        iid: 42,
        title: "Synchronize meeting-room occupancy",
        state: "opened",
        web_url: "https://gitlab.example.test/team/project/-/issues/42",
        labels: ["In Progress"],
        assignees: [{ username: "ada" }],
        description:
          "## Acceptance criteria\n\n- [ ] AC1: Occupied state updates\n- [ ] AC2: Vacant transition propagates\n",
      });
    }
    if (path.startsWith("/api/v4/projects/team%2Fproject")) {
      return json({
        id: 7,
        path_with_namespace: "team/project",
        web_url: "https://gitlab.example.test/team/project",
      });
    }
    if (path.startsWith("/api/v4/projects/7/issues/42")) {
      return json({
        iid: 42,
        title: "Synchronize meeting-room occupancy",
        state: "opened",
        labels: ["In Progress"],
        assignees: [{ username: "ada" }],
        description: "## Acceptance criteria\n\n- [ ] AC1: Occupied state updates\n- [ ] AC2: Vacant transition propagates\n",
      });
    }
    // MRs, pipelines, notes: empty collections.
    if (path.includes("merge_requests") || path.includes("pipelines") || path.includes("notes")) {
      return json([]);
    }
    return json([]);
  };
}

test("start returns one compact work context with criteria and execution state", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-start-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "start-test-token";
  try {
    await initStoryRepo(root);
    globalThis.fetch = gitlabFetchStub();

    const result = await startWork({ root, skipAuthProbe: true });
    assert.equal(result.work.iid, 42);
    assert.equal(result.work.title, "Synchronize meeting-room occupancy");
    assert.deepEqual(
      result.acceptanceCriteria.map((c) => c.id),
      ["AC-1", "AC-2"],
    );
    assert.equal(result.recommendation.reason.includes("in progress"), true);
    assert.match(result.git.branchRecommendation, /^work\/42-/);
    assert.equal(result.execution.authenticatedTransport, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("start refuses to guess when no work is assigned", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-start-empty-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "start-empty-token";
  try {
    await initStoryRepo(root);
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      const body = path === "/api/v4/user"
        ? { id: 5, username: "ada" }
        : [];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
        headers: new Headers(),
      };
    };

    await assert.rejects(() => startWork({ root, skipAuthProbe: true }), {
      code: "NO_ASSIGNED_WORK",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("check unifies criteria status, MR/pipeline gaps, and the next action", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-check-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "check-test-token";
  try {
    await initStoryRepo(root);
    globalThis.fetch = gitlabFetchStub();

    const result = await checkStory({ root });
    assert.equal(result.story, 42);
    assert.equal(result.mergeRequest, null);
    assert.equal(result.pipeline, null);
    assert.equal(result.criteria.length, 2);
    assert.equal(typeof result.nextAction, "string");
    assert.ok(result.nextAction.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
