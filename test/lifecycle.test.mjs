import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { startWork, checkStory, finishStory, handoffStory, formatFinishMarkdown, formatHandoffMarkdown } from "../dist/lifecycle.js";

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

test("finish gates completion on criteria, merge request, pipeline, and clean git", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-finish-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "finish-test-token";
  try {
    await initStoryRepo(root);
    await writeFile(join(root, ".gitignore"), ".oflow/\n");
    await run("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "wip"]);
    globalThis.fetch = gitlabFetchStub();

    const result = await finishStory({ root });
    assert.equal(result.story, 42);
    assert.equal(result.ready, false);
    const gateIds = result.gates.map((gate) => gate.id);
    assert.deepEqual(gateIds, [
      "acceptance-criteria",
      "merge-request",
      "pipeline",
      "local-git",
    ]);
    const criteriaGate = result.gates.find((gate) => gate.id === "acceptance-criteria");
    assert.equal(criteriaGate.passed, false);
    assert.ok(criteriaGate.detail.includes("not satisfied"));
    const mrGate = result.gates.find((gate) => gate.id === "merge-request");
    assert.equal(mrGate.passed, false);
    assert.equal(result.nextCommand, "oflow plan issue update --story 42 --state closed");
    assert.ok(formatFinishMarkdown(result).includes("NOT READY"));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("finish passes the pipeline gate when pipeline policy is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-finish-pipeline-disabled-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "finish-pipeline-disabled-token";
  try {
    await initStoryRepo(root);
    const configPath = join(root, ".oflow", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.workflow = { ...(config.workflow ?? {}), pipeline: "disabled" };
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(join(root, ".gitignore"), ".oflow/\n");
    await run("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "wip"]);
    globalThis.fetch = gitlabFetchStub();

    const result = await finishStory({ root });
    const pipelineGate = result.gates.find((gate) => gate.id === "pipeline");
    assert.equal(pipelineGate.passed, true);
    assert.match(pipelineGate.detail, /disabled/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("finish reports READY without CI configuration or pipeline evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-finish-ready-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "finish-ready-token";
  const story = {
    iid: 42,
    title: "Synchronize meeting-room occupancy",
    state: "opened",
    web_url: "https://gitlab.example.test/team/project/-/issues/42",
    labels: ["In Progress"],
    assignees: [{ username: "ada" }],
    description:
      "## Acceptance criteria\n\n- [x] AC1: Occupied state updates\n- [x] AC2: Vacant transition propagates\n",
  };
  const mergeRequestDescription =
    "## Acceptance criteria verification\n\n" +
    "- [x] AC-1: Occupied state updates\n  Evidence: unit test passes\n" +
    "- [x] AC-2: Vacant transition propagates\n  Evidence: unit test passes\n";
  try {
    await initStoryRepo(root);
    // F4: without .gitlab-ci.yml, enabled policy treats absent pipeline evidence as a warning.
    await writeFile(join(root, ".gitignore"), ".oflow/\n");
    await run("git", ["-C", root, "add", "."]);
    await run("git", ["-C", root, "commit", "-q", "-m", "wip"]);
    globalThis.fetch = async (input) => {
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
      if (path.startsWith("/api/v4/projects/team%2Fproject/issues/42/notes")) {
        return json([]);
      }
      if (path.startsWith("/api/v4/projects/team%2Fproject/issues/42/related_merge_requests")) {
        return json([{
          iid: 9,
          title: "Synchronize meeting-room occupancy",
          description: mergeRequestDescription,
          state: "merged",
          draft: false,
          source_branch: "work/42-occupancy",
          target_branch: "main",
          web_url: "https://gitlab.example.test/team/project/-/merge_requests/9",
        }]);
      }
      if (path.startsWith("/api/v4/projects/team%2Fproject/merge_requests/9/pipelines")) {
        return json([]);
      }
      if (path === "/api/v4/projects/team%2Fproject/issues/42") {
        return json(story);
      }
      if (path.startsWith("/api/v4/projects/team%2Fproject/issues")) {
        return json([story]);
      }
      if (path.startsWith("/api/v4/projects/team%2Fproject/pipelines")) {
        return json([]);
      }
      if (path.startsWith("/api/v4/projects/team%2Fproject")) {
        return json({
          id: 7,
          path_with_namespace: "team/project",
          web_url: "https://gitlab.example.test/team/project",
        });
      }
      return json([]);
    };

    const result = await finishStory({ root });
    assert.match(result.warnings.join("\n"), /Pipeline evidence is unknown/);
    assert.equal(result.story, 42);
    assert.equal(result.ready, true);
    for (const gate of result.gates) {
      assert.equal(gate.passed, true, gate.id + ": " + gate.detail);
    }
    const markdown = formatFinishMarkdown(result);
    assert.ok(markdown.includes("READY"));
    assert.ok(!markdown.includes("NOT READY"));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff emits compact resume context for the next agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-handoff-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "handoff-test-token";
  try {
    await initStoryRepo(root);
    await run("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "wip"]);
    globalThis.fetch = gitlabFetchStub();

    const result = await handoffStory({ root });
    assert.equal(result.story.iid, 42);
    assert.equal(result.story.title, "Synchronize meeting-room occupancy");
    assert.equal(result.project.host, "gitlab.example.test");
    assert.equal(result.project.path, "team/project");
    assert.deepEqual(
      result.criteria.map((criterion) => criterion.id),
      ["AC-1", "AC-2"],
    );
    assert.equal(result.mergeRequest, null);
    assert.ok(Array.isArray(result.nextActions));
    const markdown = formatHandoffMarkdown(result);
    assert.ok(markdown.includes("# oflow handoff"));
    assert.ok(markdown.includes("Story !42"));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
