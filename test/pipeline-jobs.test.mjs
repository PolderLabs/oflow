import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assessStory } from "../dist/assess.js";
import { main } from "../dist/cli.js";
import { formatHandoffMarkdown, handoffStory } from "../dist/lifecycle.js";

const run = promisify(execFile);

const HEAD_SHA = "story-1-sha";

/**
 * A story whose verification pipeline has the given status, with one failed
 * jobs endpoint that records whether oflow asked for it at all.
 */
async function storyFixture(t, { pipelineStatus, jobs = [], jobsStatus = 200 }) {
  const root = await mkdtemp(join(tmpdir(), "oflow-pipeline-jobs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "pipeline-jobs-test-token";

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

  const requested = { jobs: false, jobsUrl: null };
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v4/projects/team%2Fproject/pipelines/10/jobs") {
      requested.jobs = true;
      requested.jobsUrl = String(input);
      if (jobsStatus !== 200) {
        return {
          ok: false,
          status: jobsStatus,
          headers: new Headers(),
          text: async () => JSON.stringify({ message: "403 Forbidden" }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(jobs),
      };
    }
    const responses = new Map([
      ["/api/v4/projects/team%2Fproject", {
        id: 7,
        path_with_namespace: "team/project",
        web_url: "https://gitlab.example.test/team/project",
      }],
      ["/api/v4/projects/team%2Fproject/issues/1", {
        iid: 1,
        title: "Choose a pod",
        description: "Acceptance criteria:\n- [ ] AC-1: Pick a pod",
        issue_type: "issue",
        state: "opened",
        labels: [],
        assignees: [],
        milestone: null,
        iteration: null,
        task_completion_status: null,
        weight: null,
        web_url: "https://gitlab.example.test/team/project/-/issues/1",
      }],
      ["/api/v4/projects/team%2Fproject/issues/1/notes", []],
      ["/api/v4/projects/team%2Fproject/issues/1/related_merge_requests", [{
        iid: 3,
        title: "Pick a pod",
        description: "## Acceptance criteria verification\n\n- [ ] AC-1: Pick a pod",
        state: "opened",
        draft: false,
        sha: HEAD_SHA,
        source_branch: "story/1",
        target_branch: "main",
        web_url: "https://gitlab.example.test/team/project/-/merge_requests/3",
      }]],
      ["/api/v4/projects/team%2Fproject/merge_requests/3/pipelines", [{
        id: 10,
        status: pipelineStatus,
        ref: "refs/merge-requests/3/head",
        sha: HEAD_SHA,
        web_url: "https://gitlab.example.test/team/project/-/pipelines/10",
      }]],
      ["/api/v4/projects/team%2Fproject/pipelines", []],
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

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
  });

  return { root, requested };
}

test("assess names the job that failed the verification pipeline", async (t) => {
  const { root, requested } = await storyFixture(t, {
    pipelineStatus: "failed",
    jobs: [{
      id: 501,
      name: "unit-tests",
      stage: "test",
      status: "failed",
      allow_failure: false,
      failure_reason: "script_failure",
      web_url: "https://gitlab.example.test/team/project/-/jobs/501",
    }],
  });

  const result = await assessStory(root, 1);

  assert.equal(requested.jobs, true);
  assert.equal(result.remote.pipeline.id, 10);
  assert.deepEqual(result.remote.pipeline.failedJobs, [{
    id: 501,
    name: "unit-tests",
    stage: "test",
    status: "failed",
    allowFailure: false,
    webUrl: "https://gitlab.example.test/team/project/-/jobs/501",
  }]);
  assert.match(
    result.blockers.join("\n"),
    /it failed in unit-tests \(test\)/,
  );
  assert.equal(result.status, "blocked");
});

test("a green pipeline is never asked for its jobs", async (t) => {
  const { root, requested } = await storyFixture(t, { pipelineStatus: "success" });

  const result = await assessStory(root, 1);

  assert.equal(requested.jobs, false, "a passing pipeline has no failure to name");
  assert.equal(
    result.remote.pipeline.failedJobs,
    null,
    "null, not [], so an unread read is not mistaken for a clean job list",
  );
  assert.ok(
    result.blockers.every((blocker) => !/pipeline/i.test(blocker)),
    "a green pipeline must not contribute a blocker: " + result.blockers.join("; "),
  );
});

test("an unreadable job list is a warning, never a fabricated clean result", async (t) => {
  const { root } = await storyFixture(t, {
    pipelineStatus: "failed",
    jobsStatus: 403,
  });

  const result = await assessStory(root, 1);

  assert.equal(result.remote.pipeline.failedJobs, null);
  assert.match(
    result.warnings.join("\n"),
    /Could not read failed jobs for pipeline #10/,
  );
  // The pipeline itself is still red, so the block must survive the missing
  // job detail. Degrading the read must not soften the gate.
  assert.match(result.blockers.join("\n"), /Latest pipeline is failed; expected success\./);
  assert.equal(result.status, "blocked");
});

test("a failed job with allow_failure is not named as the cause", async (t) => {
  const { root } = await storyFixture(t, {
    pipelineStatus: "failed",
    jobs: [{
      id: 502,
      name: "flaky-lint",
      stage: "lint",
      status: "failed",
      allow_failure: true,
      web_url: "https://gitlab.example.test/team/project/-/jobs/502",
    }],
  });

  const result = await assessStory(root, 1);

  assert.equal(result.remote.pipeline.failedJobs.length, 1);
  assert.equal(result.remote.pipeline.failedJobs[0].allowFailure, true);
  assert.match(
    result.blockers.join("\n"),
    /only allow_failure jobs failed, so the failure is elsewhere\./,
  );
});

test("a pipeline with no failed jobs names no cause", async (t) => {
  const { root } = await storyFixture(t, { pipelineStatus: "failed", jobs: [] });

  const result = await assessStory(root, 1);

  assert.deepEqual(result.remote.pipeline.failedJobs, []);
  assert.match(result.blockers.join("\n"), /Latest pipeline is failed; expected success\./);
});

test("the job read is bounded and percent-encodes the scope filter", async (t) => {
  const { root, requested } = await storyFixture(t, {
    pipelineStatus: "failed",
    jobs: [{ id: 1, name: "unit-tests", stage: "test", status: "failed" }],
  });

  await assessStory(root, 1);

  assert.ok(requested.jobsUrl, "the jobs endpoint must be requested");
  assert.match(requested.jobsUrl, /per_page=10/);
  // Raw "[" in a query string is rejected by strict proxies and WAFs in front of
  // self-managed instances, so the scope filter must travel percent-encoded.
  assert.match(requested.jobsUrl, /scope%5B%5D=failed/);
  assert.equal(
    requested.jobsUrl.includes("["),
    false,
    "no unencoded bracket may reach the wire: " + requested.jobsUrl,
  );
});

test("oflow verify names the failed job through the real CLI text output", async (t) => {
  const { root } = await storyFixture(t, {
    pipelineStatus: "failed",
    jobs: [{
      id: 501,
      name: "unit-tests",
      stage: "test",
      status: "failed",
      allow_failure: false,
      web_url: "https://gitlab.example.test/team/project/-/jobs/501",
    }],
  });
  const previousCwd = process.cwd();
  process.chdir(root);
  let out = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  t.after(() => {
    process.chdir(previousCwd);
    process.stdout.write = originalWrite;
  });
  process.stdout.write = (chunk, ...rest) => {
    out += String(chunk);
    return originalWrite(chunk, ...rest);
  };

  const code = await main(["verify", "--story", "1"]);

  process.stdout.write = originalWrite;
  assert.equal(code, 1, "a failed pipeline must still block");
  assert.match(out, /Failed jobs:/);
  assert.match(out, /unit-tests \(test, failed\)/);
  assert.match(out, /https:\/\/gitlab\.example\.test\/team\/project\/-\/jobs\/501/);
});

test("oflow handoff copies the failed job into the next agent's brief", async (t) => {
  const { root } = await storyFixture(t, {
    pipelineStatus: "failed",
    jobs: [{ id: 501, name: "unit-tests", stage: "test", status: "failed" }],
  });

  const markdown = formatHandoffMarkdown(await handoffStory({ root, story: 1 }));

  assert.match(markdown, /## Failed jobs/);
  assert.match(markdown, /unit-tests \(test, failed\)/);
});

test("a green pipeline's handoff brief has no failed jobs section", async (t) => {
  // The read never happened. Rendering "no failed jobs" here would claim a
  // clean job list nobody looked at.
  const { root, requested } = await storyFixture(t, { pipelineStatus: "success" });

  const markdown = formatHandoffMarkdown(await handoffStory({ root, story: 1 }));

  assert.equal(requested.jobs, false);
  assert.equal(
    markdown.includes("## Failed jobs"),
    false,
    "an unread job list must not be rendered as an empty one",
  );
});
