import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { main } from "../dist/cli.js";
import { readWorkItemsCache } from "../dist/work-cache.js";

const cli = join(process.cwd(), "dist", "cli.js");

test("auth set accepts stdin and status never prints the token", () => {
  const configHome = mkdtempSync(join(tmpdir(), "oflow-cli-"));
  const environment = { ...process.env, OFLOW_CONFIG_HOME: configHome };
  try {
    const saved = execFileSync(
      process.execPath,
      [cli, "auth", "set", "--host", "gitlab.example.test", "--token-stdin", "--json"],
      { env: environment, input: "secret-token\n", encoding: "utf8" },
    );
    assert.match(saved, /"action": "saved"/);
    assert.ok(!saved.includes("secret-token"));

    const status = execFileSync(
      process.execPath,
      [cli, "auth", "status", "--host", "gitlab.example.test", "--json"],
      { env: environment, encoding: "utf8" },
    );
    assert.match(status, /"activeSource": "stored"/);
    assert.ok(!status.includes("secret-token"));
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("auth rejects token command-line arguments without echoing the value", () => {
  const result = spawnSync(
    process.execPath,
    [cli, "auth", "set", "--host", "gitlab.example.test", "--token", "secret-token"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Do not pass GitLab tokens as command-line arguments/);
  assert.ok(!result.stderr.includes("secret-token"));
});

test("CLI runs through a symlink like an npm global binary", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "oflow-bin-"));
  const linkedCli = join(directory, "oflow");
  try {
    symlinkSync(cli, linkedCli);
    const result = execFileSync(linkedCli, ["help"], { encoding: "utf8" });
    assert.match(result, /^oflow - GitLab-first workflow/);
    assert.match(result, /filters: --label, --milestone, --iteration, --epic, --assignee, --mine, --author/);
    assert.match(result, /epic \[--iid <iid>\] \[--limit <n>\]/);
    assert.match(result, /iteration \[--group\] \[--state <state>\]/);
    assert.match(result, /cadence \[--limit <n>\]/);
    assert.match(result, /sync --epics/);
    assert.match(result, /plan issues labels --stories 1,2/);
    assert.match(result, /plan issues update --stories 1,2/);
    assert.match(result, /plan issues update --stories 1,2 --iteration/);
    assert.match(result, /plan assess --story <iid>/);
    assert.match(result, /plan issue update --story <iid> --iteration <title\|iid\|none>/);
    assert.match(result, /audit \[--limit <n>\] \[--json\]/);
    assert.match(result, /sync --stale-days <n>/);
    assert.match(result, /sync --summary/);
    assert.match(result, /sync --cached/);
    assert.match(result, /sync --refresh/);
    assert.match(result, /work --mine --refresh/);
    assert.match(result, /work --mine --cached/);
    assert.match(result, /mr --iid <iid> \[--full\] \[--json\]/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("work --mine refreshes once and can then be read from SQLite offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-work-mine-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "work-mine-cli-test-token";
  let userRequests = 0;
  let issueRequests = 0;
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v4/user") {
        userRequests += 1;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({ id: 7, username: "zakar" }),
        };
      }
      if (url.pathname.endsWith("/issues")) {
        issueRequests += 1;
        assert.equal(url.searchParams.get("assignee_username[]"), "zakar");
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify([{
            iid: 23,
            title: "Verify the supported XLOCK integration path",
            state: "opened",
            labels: ["User Story"],
            assignees: [{ username: "zakar" }],
            updated_at: "2026-09-17T10:00:00Z",
            web_url: "https://gitlab.example.test/team/project/-/issues/23",
          }]),
        };
      }
      throw new Error("unexpected request " + url.pathname);
    };
    assert.equal(await main(["work", "--root", root, "--mine", "--refresh", "--json"]), 0);
    const refreshed = await readWorkItemsCache({
      root,
      host: "gitlab.example.test",
      projectPath: "team/project",
      query: { state: "opened", issueLimit: 100, issueFilters: {}, mine: true },
    });
    assert.equal(refreshed.cache.actorUsername, "zakar");
    assert.equal(refreshed.items[0].iid, 23);

    globalThis.fetch = async () => {
      throw new Error("cached work must not contact GitLab");
    };
    assert.equal(await main(["work", "--root", root, "--mine", "--cached", "--json"]), 0);
    assert.equal(userRequests, 1);
    assert.equal(issueRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI routes single-story iteration assignment into a guarded plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-iteration-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "iteration-cli-test-token";
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const value = url.pathname.endsWith("/iterations")
        ? [{ id: 53, iid: 13, title: "Sprint 2", state: "upcoming" }]
        : {
            iid: 42,
            title: "Choose a pod",
            state: "opened",
            iteration: null,
            updated_at: "2026-09-17T10:00:00Z",
          };
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(value),
      };
    };
    const exitCode = await main([
      "plan",
      "issue",
      "update",
      "--root",
      root,
      "--story",
      "42",
      "--iteration",
      "Sprint 2",
      "--json",
    ]);
    assert.equal(exitCode, 0);
    const planFiles = readdirSync(join(root, ".oflow", "state", "plans"));
    assert.equal(planFiles.length, 1);
    const plan = JSON.parse(readFileSync(join(root, ".oflow", "state", "plans", planFiles[0]), "utf8"));
    assert.equal(plan.operation.kind, "issue.iteration.update");
    assert.equal(plan.operation.iterationIid, 13);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI routes bulk iteration assignment into a guarded plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-bulk-iteration-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "bulk-iteration-cli-test-token";
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const value = url.pathname.endsWith("/iterations")
        ? [{ id: 53, iid: 13, title: "Sprint 2", state: "upcoming" }]
        : {
            iid: Number(url.pathname.split("/").pop()),
            title: "Story",
            state: "opened",
            iteration: null,
            updated_at: null,
          };
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(value),
      };
    };
    const exitCode = await main([
      "plan",
      "issues",
      "update",
      "--root",
      root,
      "--stories",
      "17,18",
      "--iteration",
      "Sprint 2",
      "--json",
    ]);
    assert.equal(exitCode, 0);
    const planFiles = readdirSync(join(root, ".oflow", "state", "plans"));
    assert.equal(planFiles.length, 1);
    const plan = JSON.parse(readFileSync(join(root, ".oflow", "state", "plans", planFiles[0]), "utf8"));
    assert.equal(plan.operation.kind, "issues.iteration.update");
    assert.deepEqual(plan.operation.issueIids, [17, 18]);
    assert.equal(plan.operation.iterationIid, 13);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit reads local lifecycle history without contacting GitLab", () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-audit-cli-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const auditPath = join(root, ".oflow", "state", "audit.jsonl");
    mkdirSync(join(root, ".oflow", "state"), { recursive: true });
    writeFileSync(auditPath, JSON.stringify({
      version: 1,
      at: "2026-01-01T00:00:00.000Z",
      action: "verified",
      planId: "plan-1",
      state: "verified",
      operation: {
        kind: "issues.planning.update",
        host: "gitlab.example.test",
        projectPath: "team/project",
        target: "#17, #18",
      },
      details: { issueCount: 2, verificationPassed: true, verificationChecks: 4 },
    }) + "\n");
    const output = execFileSync(
      process.execPath,
      [cli, "audit", "--root", root, "--limit", "1", "--json"],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].action, "verified");
    assert.equal(result.events[0].details.verificationPassed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan assess creates a guarded owner/timebox plan from a story assessment", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-assessment-plan-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "assessment-plan-cli-test-token";
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(
      join(root, ".oflow", "config.json"),
      JSON.stringify({
        managedBy: "oflow",
        version: 1,
        project: { host: "gitlab.example.test", path: "team/project" },
      }),
    );
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const responses = new Map([
        ["/api/v4/projects/team%2Fproject", { id: 7, path_with_namespace: "team/project", web_url: "https://gitlab.example.test/team/project" }],
        ["/api/v4/projects/team%2Fproject/issues/42", {
          iid: 42,
          title: "Choose a pod",
          description: "Acceptance criteria:\n- [ ] AC-1: Pick a pod",
          state: "opened",
          labels: ["User Story"],
          assignees: [],
          milestone: null,
          iteration: null,
          task_completion_status: { count: 1, completed_count: 0 },
          web_url: "https://gitlab.example.test/team/project/-/issues/42",
        }],
        ["/api/v4/projects/team%2Fproject/issues/42/notes", []],
        ["/api/v4/projects/team%2Fproject/issues/42/related_merge_requests", []],
        ["/api/v4/projects/team%2Fproject/pipelines", []],
        ["/api/v4/users", [{ id: 6, username: "zakar", name: "Zakar" }]],
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
    const assessmentExitCode = await main([
      "assess",
      "--root",
      root,
      "--story",
      "42",
      "--json",
    ]);
    assert.equal(assessmentExitCode, 0);
    const exitCode = await main([
      "plan",
      "assess",
      "--root",
      root,
      "--story",
      "42",
      "--assignee",
      "zakar",
      "--milestone",
      "Sprint 1",
    ]);
    assert.equal(exitCode, 0);
    const planFiles = readdirSync(join(root, ".oflow", "state", "plans"));
    assert.equal(planFiles.length, 1);
    const result = JSON.parse(readFileSync(join(root, ".oflow", "state", "plans", planFiles[0]), "utf8"));
    assert.equal(result.operation.kind, "issue.update");
    assert.deepEqual(result.operation.changes.assignee_ids, [6]);
    assert.equal(result.operation.changes.milestone, "Sprint 1");
    assert.equal(result.sourceAssessment.status, "unknown");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});
