import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { executeIssueUpdate } from "../dist/executor.js";

const run = promisify(execFile);

function fakeGlabScript(root, calls) {
  const script = join(root, "fake-glab.mjs");
  const source = [
    "#!/usr/bin/env node",
    "import { argv } from 'node:process';",
    "import { writeFileSync, readFileSync } from 'node:fs';",
    "const args = argv.slice(2);",
    "const log = '" + calls + "';",
    "writeFileSync(log, readFileSync(log, 'utf8') + JSON.stringify(args) + '\\n', 'utf8');",
    "if (args[0] === 'api' && args[4] === 'PUT') {",
    "  console.log(JSON.stringify({ iid: 42, title: 'Updated via glab', state: 'opened', updated_at: '2026-09-18T12:00:00Z', labels: ['In Progress'] }));",
    "  process.exit(0);",
    "}",
    "console.log(JSON.stringify({ iid: 42, title: 'Choose a pod', state: 'opened', updated_at: '2026-09-17T10:00:00Z', labels: [] }));",
    "",
  ].join("\n");
  return { script, source };
}

test("issue update executes through glab when no direct token exists", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-executor-"));
  const previousToken = process.env.GITLAB_TOKEN;
  const previousGlab = process.env.OFLOW_GLAB_BIN;
  delete process.env.GITLAB_TOKEN;
  const calls = join(root, "calls.log");
  await writeFile(calls, "");
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    const { script, source } = fakeGlabScript(root, calls);
    await writeFile(script, source);
    await chmod(script, 0o755);
    process.env.OFLOW_GLAB_BIN = script;

    const outcome = await executeIssueUpdate({
      root,
      host: "gitlab.example.test",
      projectPath: "team/project",
      issueIid: 42,
      changes: {
        add_labels: "In Progress",
        issue_type: "task",
        labels: "Ready",
        epic_id: 9,
        due_date: "2026-10-01",
        weight: 3,
        milestone: "Sprint 1",
      },
      expectedUpdatedAt: "2026-09-17T10:00:00Z",
      createRestClient: () => {
        throw new Error("REST client must not be constructed without a token");
      },
    });

    assert.equal(outcome.backend, "glab");
    assert.equal(outcome.issue.title, "Updated via glab");

    const logged = (await readFileLog(calls)).map((entry) => JSON.parse(entry));
    // Auth probe (--version, auth status) then stale-guard GET then the PUT.
    const apiCalls = logged.filter((entry) => entry[0] === "api");
    assert.equal(apiCalls.length, 2);
    assert.equal(apiCalls[0][4], "GET");
    assert.equal(apiCalls[1][4], "PUT");
    assert.ok(apiCalls[1].includes("projects/team%2Fproject/issues/42"));
    assert.ok(apiCalls[1].includes("--field") && apiCalls[1].includes("add_labels=In Progress"));
    assert.ok(apiCalls[1].includes("issue_type=task"));
    // Field parity: glab path must forward the same issue update fields REST accepts.
    assert.ok(apiCalls[1].includes("--field") && apiCalls[1].includes("labels=Ready"));
    assert.ok(apiCalls[1].includes("--field") && apiCalls[1].includes("epic_id=9"));
    assert.ok(apiCalls[1].includes("--field") && apiCalls[1].includes("due_date=2026-10-01"));
    assert.ok(apiCalls[1].includes("--field") && apiCalls[1].includes("weight=3"));
    assert.ok(apiCalls[1].includes("--field") && apiCalls[1].includes("milestone=Sprint 1"));
    // No token ever appears in any subprocess argv.
    for (const entry of logged) {
      assert.equal(entry.some((arg) => /token/i.test(arg)), false);
    }
  } finally {
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    if (previousGlab === undefined) delete process.env.OFLOW_GLAB_BIN;
    else process.env.OFLOW_GLAB_BIN = previousGlab;
    await rm(root, { recursive: true, force: true });
  }
});

async function readFileLog(path) {
  const { readFile } = await import("node:fs/promises");
  return (await readFile(path, "utf8")).split("\n").filter(Boolean);
}

test("issue update refuses without any authenticated backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-executor-none-"));
  const previousToken = process.env.GITLAB_TOKEN;
  const previousGlab = process.env.OFLOW_GLAB_BIN;
  delete process.env.GITLAB_TOKEN;
  try {
    await assert.rejects(
      () =>
        executeIssueUpdate({
          root,
          host: "gitlab.example.test",
          projectPath: "team/project",
          issueIid: 42,
          changes: { title: "Nope" },
          createRestClient: () => {
            throw new Error("unreachable");
          },
        }),
      { code: "MISSING_EXECUTION_BACKEND" },
    );
  } finally {
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    if (previousGlab === undefined) delete process.env.OFLOW_GLAB_BIN;
    else process.env.OFLOW_GLAB_BIN = previousGlab;
    await rm(root, { recursive: true, force: true });
  }
});
