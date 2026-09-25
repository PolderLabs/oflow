import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("verify-local --json runs configured argv checks without GitLab access", () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-verify-local-cli-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.test"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Test User"]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow", version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
      workflow: { verification: { policy: "required", checks: [
        { id: "node-version", command: [process.execPath, "--version"] },
      ] } },
    }));
    writeFileSync(join(root, ".gitignore"), ".oflow/cache/\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-qm", "configure"]);
    const result = spawnSync(process.execPath, [cli, "verify-local", "--root", root, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "passed");
    assert.equal(parsed.perCheck[0].id, "node-version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    assert.match(result, /approve <plan\.json>/);
    assert.match(result, /apply <plan\.json>/);
    assert.match(result, /apply <plan\.json> --yes/);
    assert.match(result, /work \[filters\] \[--state opened\|closed\|all\]/);
    assert.match(result, /work --iid <iid>/);
    assert.match(result, /plan issue update --story <iid> --convert-ac/);
    assert.match(result, /pipeline=disabled/);
    assert.match(result, /planPath/);
    assert.match(result, /audit \[--limit <n>\] \[--json\]/);
    assert.match(result, /cache status \[--json\]/);
    assert.match(result, /dashboard \[--port <n>\]/);
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

test("plan --help routes to discoverable command help", () => {
  const result = spawnSync(process.execPath, [cli, "plan", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^oflow - GitLab-first workflow/);
  assert.match(result.stdout, /approve <plan\.json>/);
  assert.match(result.stdout, /apply <plan\.json>/);
});

test("identity --json emits a stable secret-free principal record", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-identity-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "identity-cli-test-token";
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
      assert.equal(url.pathname, "/api/v4/user");
      return jsonResponse({
        id: 7,
        username: "alice",
        name: "Alice",
        email: "alice@example.test",
        public_email: true,
      });
    };
    const out = captureStdout();
    try {
      assert.equal(await main(["identity", "--root", root, "--json"]), 0);
      const identity = JSON.parse(out.read());
      assert.deepEqual(identity, {
        host: "gitlab.example.test",
        source: "environment",
        id: 7,
        username: "alice",
        name: "Alice",
        email: null,
      });
      assert.ok(!out.read().includes("identity-cli-test-token"));
    } finally {
      out.restore();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI routes --type task into a guarded work-item create plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-task-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "task-cli-test-token";
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
      assert.equal(url.pathname, "/api/v4/projects/team%2Fproject");
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({
          id: 7,
          path_with_namespace: "team/project",
          web_url: "https://gitlab.example.test/team/project",
        }),
      };
    };
    assert.equal(await main([
      "plan",
      "issue",
      "create",
      "--root",
      root,
      "--title",
      "Create a real task",
      "--type",
      "task",
      "--json",
    ]), 0);
    const planFiles = readdirSync(join(root, ".oflow", "state", "plans"));
    assert.equal(planFiles.length, 1);
    const plan = JSON.parse(readFileSync(join(root, ".oflow", "state", "plans", planFiles[0]), "utf8"));
    assert.equal(plan.operation.issue.issue_type, "task");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI routes merge-request create flags into a guarded MR plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-mr-create-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "mr-create-cli-test-token";
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    execFileSync("git", ["-C", root, "checkout", "-q", "-b", "story-42-pick-a-pod"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    const seen = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      if (url.pathname === "/api/v4/projects/team%2Fproject") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({
            id: 7,
            path_with_namespace: "team/project",
            default_branch: "main",
          }),
        };
      }
      if (url.pathname === "/api/v4/projects/team%2Fproject/issues/42") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({ iid: 42, title: "Pick a pod" }),
        };
      }
      throw new Error("unexpected fetch: " + url.pathname);
    };
    assert.equal(await main([
      "plan",
      "merge-request",
      "create",
      "--root",
      root,
      "--story",
      "42",
      "--source-branch",
      "feature/pick-a-pod",
      "--target-branch",
      "release/1.2",
      "--title",
      "Pick a pod",
      "--description",
      "Implements story #42.",
      "--json",
    ]), 0);
    const planFiles = readdirSync(join(root, ".oflow", "state", "plans"));
    assert.equal(planFiles.length, 1);
    const plan = JSON.parse(readFileSync(join(root, ".oflow", "state", "plans", planFiles[0]), "utf8"));
    assert.equal(plan.operation.kind, "merge_request.create");
    assert.equal(plan.operation.sourceBranch, "feature/pick-a-pod");
    assert.equal(plan.operation.targetBranch, "release/1.2");
    assert.equal(plan.operation.title, "Pick a pod");
    assert.equal(plan.operation.description, "Implements story #42.");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI runs the full delegated flow: delegate, receipt, verify", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-mr-delegated-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "mr-delegated-cli-token";
  const mergeRequests = [];
  const planRelative = (name) => join(".oflow", "state", "plans", name);
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
      if (url.pathname === "/api/v4/projects/team%2Fproject") {
        return jsonResponse({ id: 7, path_with_namespace: "team/project", default_branch: "main" });
      }
      if (url.pathname === "/api/v4/projects/team%2Fproject/issues/42") {
        return jsonResponse({ iid: 42, title: "Pick a pod" });
      }
      if (url.pathname === "/api/v4/projects/team%2Fproject/merge_requests" && url.searchParams.get("state") === "all") {
        return jsonResponse(mergeRequests);
      }
      throw new Error("unexpected fetch: " + url.pathname);
    };

    assert.equal(await main([
      "plan", "merge-request", "create", "--root", root,
      "--story", "42", "--source-branch", "feature/pick-a-pod",
      "--target-branch", "main", "--title", "Pick a pod",
      "--description", "Implements story #42.", "--json",
    ]), 0);
    const planName = readdirSync(join(root, ".oflow", "state", "plans"))[0];
    const planPath = join(root, planRelative(planName));

    assert.equal(await main(["approve", planPath, "--root", root, "--json"]), 0);

    // Direct apply must refuse delegated-only plans (exit 1, stderr message).
    assert.equal(await main(["apply", planPath, "--root", root, "--json"]), 1);

    assert.equal(await main(["apply", planPath, "--root", root, "--delegate", "--json"]), 0);
    const delegated = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(delegated.state, "approved");

    // Verify before a receipt is refused: the plan is not applied yet.
    assert.equal(await main(["verify", planPath, "--root", root, "--json"]), 1);

    const receiptPath = join(root, "receipt.json");
    writeFileSync(receiptPath, JSON.stringify({
      backend: "gitlab-mcp",
      action: "merge_request.create",
      executedAt: "2026-09-21T12:30:00Z",
      success: true,
      result: { iid: 9, web_url: "https://gitlab.example.test/team/project/-/merge_requests/9" },
    }));
    assert.equal(await main(["apply", planPath, "--root", root, "--receipt", receiptPath, "--json"]), 0);
    let applied = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(applied.state, "applied");
    assert.equal(applied.execution.backend, "gitlab-mcp");

    mergeRequests.push({
      iid: 9,
      source_branch: "feature/pick-a-pod",
      target_branch: "main",
      title: "Pick a pod",
      description: "Implements story #42.",
    });
    assert.equal(await main(["verify", planPath, "--root", root, "--json"]), 0);
    const verified = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(verified.state, "verified");
    assert.equal(verified.verification.passed, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(value),
  };
}

function captureStdout() {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString(typeof encoding === "string" ? encoding : "utf8")
      : String(chunk);
    const done = () => {
      if (typeof encoding === "function") encoding();
      else if (typeof callback === "function") callback();
    };
    // Absorb only JSON object payloads from oflow --json commands.
    // Everything else (TAP lines, node:test protocol frames, markdown,
    // stderr-shaped diagnostics) must keep flowing to the real stdout or
    // the test runner silently drops results.
    if (text.trimStart().startsWith("{")) {
      captured += text;
      done();
      return true;
    }
    const result = original(text, encoding, typeof encoding === "function" ? undefined : callback);
    if (typeof encoding === "function") encoding();
    return result;
  };
  return {
    read() {
      const key = captured.indexOf('"planPath"');
      if (key >= 0) {
        const start = captured.lastIndexOf("{", key);
        if (start >= 0) {
          return captured.slice(start);
        }
      }
      const start = captured.indexOf("{");
      if (start < 0) return captured;
      return captured.slice(start);
    },
    restore() {
      process.stdout.write = original;
    },
  };
}

/** Captures oflow's stderr diagnostics so refusal messages can be asserted. */
function captureStderr() {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk, encoding, callback) => {
    captured += Buffer.isBuffer(chunk)
      ? chunk.toString(typeof encoding === "string" ? encoding : "utf8")
      : String(chunk);
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  };
  return {
    read() {
      return captured;
    },
    restore() {
      process.stderr.write = original;
    },
  };
}

test("cache diagnostics stay local and report a missing read model without a token", () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-cache-status-cli-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const status = execFileSync(process.execPath, [cli, "cache", "status", "--root", root, "--json"], {
      encoding: "utf8",
      env: { ...process.env, GITLAB_TOKEN: "must-not-be-used" },
    });
    assert.match(status, /"state": "missing"/);
    const refresh = execFileSync(process.execPath, [cli, "cache", "request-refresh", "--root", root, "--json"], {
      encoding: "utf8",
    });
    assert.match(refresh, /"accepted": false/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work --mine refreshes and validates cached data against current identity", async () => {
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
          text: async () => JSON.stringify({ id: 7, username: "test-user" }),
        };
      }
      if (url.pathname.endsWith("/issues")) {
        issueRequests += 1;
        assert.equal(url.searchParams.get("assignee_id"), "7");
        assert.equal(url.searchParams.get("assignee_username[]"), null);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify([{
            iid: 23,
            title: "Verify the supported XLOCK integration path",
            state: "opened",
            labels: ["User Story"],
            assignees: [{ username: "test-user" }],
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
      query: { state: "opened", issueLimit: 100, issueFilters: {}, mine: true, actorId: 7 },
    });
    assert.equal(refreshed.cache.actorId, 7);
    assert.equal(refreshed.cache.actorUsername, "test-user");
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

test("work --mine --cached rejects a legacy identity-less cache offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-work-mine-legacy-cli-"));
  const originalFetch = globalThis.fetch;
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow", "cache"), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(root, ".oflow", "cache", "oflow.db"));
    database.exec(`
      CREATE TABLE oflow_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO oflow_meta VALUES ('schema_version', '3');
      CREATE TABLE work_item_cache_queries (
        cache_key TEXT PRIMARY KEY, project_key TEXT NOT NULL, query_json TEXT NOT NULL,
        state TEXT NOT NULL, issue_limit INTEGER NOT NULL, mine INTEGER NOT NULL,
        actor_username TEXT, saved_at TEXT NOT NULL, work_items_may_be_truncated INTEGER NOT NULL,
        pagination_json TEXT NOT NULL, actor_id INTEGER
      );
    `);
    database.close();
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await main(["work", "--root", root, "--mine", "--cached", "--json"]), 1);
  } finally {
    globalThis.fetch = originalFetch;
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
        ["/api/v4/users", [{ id: 6, username: "test-user", name: "Test User" }]],
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
      "test-user",
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

test("plan JSON responses include a stable top-level planPath", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-plan-path-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "plan-path-test-token";
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    globalThis.fetch = async (input) => jsonResponse({
      iid: 42,
      title: "Pick a pod",
      state: "opened",
      labels: [],
      web_url: "https://gitlab.example.test/team/project/-/issues/42",
      updated_at: "2026-09-17T10:00:00Z",
    });
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "note", "--root", root, "--story", "42",
        "--body", "Progress: ready for review.", "--json",
      ]), 0);
      const parsed = JSON.parse(out.read());
      assert.equal(typeof parsed.planPath, "string");
      assert.match(parsed.planPath, /[\\/]\.oflow[\\/]state[\\/]plans[\\/].+\.json$/);
      assert.equal(parsed.plan.operation.kind, "issue.note.create");
      assert.equal(parsed.path, parsed.planPath);
    } finally {
      out.restore();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply --yes only accepts issue.note.create plans and approve rejects --yes", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-yes-cli-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));

    const approveYes = spawnSync(
      process.execPath,
      [cli, "approve", "--yes", "--root", root],
      { encoding: "utf8" },
    );
    assert.notEqual(approveYes.status, 0);
    assert.match(approveYes.stderr, /--yes is only supported with apply/);

    const convertElsewhere = spawnSync(
      process.execPath,
      [cli, "work", "--convert-ac", "--root", root],
      { encoding: "utf8" },
    );
    assert.notEqual(convertElsewhere.status, 0);
    assert.match(convertElsewhere.stderr, /--convert-ac is only supported with plan issue update/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work --state closed|all surfaces the effective filter and issueType", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-work-state-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "work-state-test-token";
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    let seenState = null;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/issues")) {
        seenState = url.searchParams.get("state");
        return jsonResponse([{
          iid: 7,
          title: "Closed story",
          state: "closed",
          issue_type: "task",
          labels: [],
          assignees: [],
          web_url: "https://gitlab.example.test/team/project/-/issues/7",
        }]);
      }
      return jsonResponse({ id: 7, path_with_namespace: "team/project" });
    };
    const out = captureStdout();
    try {
      assert.equal(await main(["work", "--root", root, "--state", "closed", "--json"]), 0);
      assert.equal(seenState, "closed");
      const parsed = JSON.parse(out.read());
      assert.equal(parsed.state, "closed");
      assert.equal(parsed.query.state, "closed");
      assert.equal(parsed.issues[0].issueType, "task");

      out.restore();
      const outAll = captureStdout();
      try {
        assert.equal(await main(["work", "--root", root, "--state", "all", "--json"]), 0);
        const allParsed = JSON.parse(outAll.read());
        assert.equal(allParsed.state, "all");
        assert.equal(allParsed.query.state, "all");
      } finally {
        outAll.restore();
      }
    } finally {
      out.restore();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("work --iid uses the normalized single-item read path", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-work-iid-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "work-iid-test-token";
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    let requestedPath = null;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requestedPath = url.pathname;
      if (url.pathname === "/api/v4/projects/team%2Fproject/issues/9") {
        return jsonResponse({
          iid: 9,
          title: "Normalized read",
          state: "opened",
          issue_type: "issue",
          labels: ["User Story"],
          assignees: [],
          web_url: "https://gitlab.example.test/team/project/-/issues/9",
        });
      }
      return jsonResponse({ id: 7, path_with_namespace: "team/project" });
    };
    const out = captureStdout();
    try {
      assert.equal(await main(["work", "--root", root, "--iid", "9", "--json"]), 0);
      assert.equal(requestedPath, "/api/v4/projects/team%2Fproject/issues/9");
      const parsed = JSON.parse(out.read());
      assert.equal(parsed.source, "normalized-issue-read");
      assert.equal(parsed.state, "opened");
      assert.equal(parsed.issue.iid, 9);
      assert.equal(parsed.issue.issueType, "issue");
    } finally {
      out.restore();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan issue note --stories creates a bounded bulk note plan with planPath", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-bulk-note-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "bulk-note-cli-test-token";
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
      const match = url.pathname.match(/\/issues\/(\d+)$/);
      if (match) {
        return jsonResponse({
          iid: Number(match[1]),
          title: "Story " + match[1],
          state: "opened",
          labels: [],
          updated_at: "2026-09-17T10:00:00Z",
          web_url: "https://gitlab.example.test/team/project/-/issues/" + match[1],
        });
      }
      return jsonResponse({ id: 7, path_with_namespace: "team/project" });
    };
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "note", "--root", root,
        "--stories", "42,43",
        "--body", "Shared progress note.",
        "--json",
      ]), 0);
      const parsed = JSON.parse(out.read());
      assert.equal(typeof parsed.planPath, "string");
      assert.equal(parsed.plan.operation.kind, "issues.notes.create");
      assert.deepEqual(parsed.plan.operation.issueIids, [42, 43]);
      assert.equal(parsed.plan.operation.body, "Shared progress note.");
    } finally {
      out.restore();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan issue update --convert-ac produces a guarded description conversion plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-convert-ac-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "convert-ac-cli-test-token";
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    globalThis.fetch = async (input) => jsonResponse({
      iid: 42,
      title: "Choose a pod",
      state: "opened",
      description: "## Done when\n\n- the door locks on close\n",
      labels: [],
      updated_at: "2026-09-17T10:00:00Z",
      web_url: "https://gitlab.example.test/team/project/-/issues/42",
    });
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root,
        "--story", "42", "--convert-ac", "--json",
      ]), 0);
      const raw = out.read();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(
          "stdout JSON parse failed: " + error.message +
          " | hasPlanPath=" + raw.includes('"planPath"') +
          " | head=" + JSON.stringify(raw.slice(0, 120)) +
          " | tail=" + JSON.stringify(raw.slice(-80)),
        );
      }
      assert.equal(typeof parsed.planPath, "string");
      assert.equal(parsed.plan.operation.kind, "issue.update");
      assert.match(parsed.plan.operation.changes.description, /- \[ \] AC-1: the door locks on close/);
    } finally {
      out.restore();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan issue update reads --description-file verbatim and writes a plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-issue-descfile-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "issue-descfile-cli-test-token";
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    const descriptionPath = join(root, "body.md");
    const description = [
      "## Acceptance criteria verification",
      "",
      "- [ ] AC-1: body from a file",
      "  Evidence: trailing spaces  ",
    ].join("\n");
    writeFileSync(descriptionPath, description, "utf8");
    globalThis.fetch = async (input) => jsonResponse({
      iid: 42,
      title: "Choose a pod",
      description: "existing",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root,
        "--story", "42", "--description-file", descriptionPath, "--json",
      ]), 0);
      const parsed = JSON.parse(out.read()).plan;
      assert.equal(parsed.operation.kind, "issue.update");
      assert.equal(parsed.operation.changes.description, description);
      assert.equal(parsed.operation.changes.title, undefined);
      const persisted = JSON.parse(readFileSync(join(root, ".oflow", "state", "plans", parsed.id + ".json"), "utf8"));
      assert.equal(persisted.operation.changes.description, description);
    } finally {
      out.restore();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan issue create reads --description-file into the issue body", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-issue-create-descfile-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "issue-create-descfile-cli-test-token";
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    const descriptionPath = join(root, "body.md");
    writeFileSync(descriptionPath, "Body from a file.\n", "utf8");
    globalThis.fetch = async () => jsonResponse({ id: 7, path_with_namespace: "team/project" });
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "create", "--root", root,
        "--title", "Pick a pod", "--description-file", descriptionPath, "--json",
      ]), 0);
      const parsed = JSON.parse(out.read()).plan;
      assert.equal(parsed.operation.kind, "issue.create");
      assert.equal(parsed.operation.issue.description, "Body from a file.\n");
    } finally {
      out.restore();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

// A create plan stores the description at the top level of `operation`, while an
// update plan nests it under `changes`, so each case reads its own path. All
// four run through main() against a stubbed GitLab host; nothing hits network.
for (const [resource, operation, path, argv, stub] of [
  [
    "label", "create", ["description"],
    ["plan", "label", "create", "--name", "bug", "--color", "#ff0000"],
    { labels: [] },
  ],
  [
    "label", "update", ["changes", "description"],
    ["plan", "label", "update", "--label", "bug"],
    { labels: [{ name: "bug", color: "#ff0000" }] },
  ],
  [
    "milestone", "create", ["description"],
    ["plan", "milestone", "create", "--title", "M1"],
    { milestones: [] },
  ],
  [
    "milestone", "update", ["changes", "description"],
    ["plan", "milestone", "update", "--milestone", "3"],
    { milestones: [{ id: 3, title: "M1" }] },
  ],
]) {
  test(`plan ${resource} ${operation} reads --description-file into the plan`, async () => {
    const root = mkdtempSync(join(tmpdir(), `oflow-${resource}-${operation}-descfile-cli-`));
    const originalFetch = globalThis.fetch;
    const previousToken = process.env.GITLAB_TOKEN;
    process.env.GITLAB_TOKEN = `${resource}-${operation}-descfile-cli-test-token`;
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
      mkdirSync(join(root, ".oflow"), { recursive: true });
      writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
        managedBy: "oflow",
        version: 1,
        project: { host: "gitlab.example.test", path: "team/project" },
      }));
      const description = [
        "Label guidance written from a file.",
        "",
        "- [ ] keep this line intact  ",
      ].join("\n");
      const descriptionPath = join(root, "body.md");
      writeFileSync(descriptionPath, description, "utf8");
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/labels")) return jsonResponse(stub.labels);
        if (url.pathname.endsWith("/milestones")) return jsonResponse(stub.milestones);
        return jsonResponse({ id: 7, path_with_namespace: "team/project" });
      };
      const out = captureStdout();
      try {
        assert.equal(await main([
          ...argv, "--root", root, "--description-file", descriptionPath, "--json",
        ]), 0);
        const parsed = JSON.parse(out.read()).plan;
        const value = path.reduce((node, key) => node?.[key], parsed.operation);
        assert.equal(value, description);
        const persisted = JSON.parse(readFileSync(join(root, ".oflow", "state", "plans", parsed.id + ".json"), "utf8"));
        assert.equal(path.reduce((node, key) => node?.[key], persisted.operation), description);
      } finally {
        out.restore();
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = previousToken;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// A criterion tick is a description write: GitLab derives task completion by
// parsing `- [ ]` / `- [x]` out of the description and exposes no writable
// field for it. These cover the bracket flip, the guarded note, and the
// refusals that keep the plan honest.
const CRITERION_ISSUE = [
  "## Acceptance criteria",
  "",
  "- [ ] AC-1: first  ",
  "- [ ] AC-2: second",
  "- [x] AC-3: third",
  "",
].join("\n");

async function withCriterionFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "oflow-criterion-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "criterion-cli-test-token";
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    // await so the finally block cannot delete the fixture before the
    // async body has finished with it.
    return await run(root);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
}

test("plan issue update --check ticks the criterion and audits it in the same plan", async () => {
  await withCriterionFixture(async (root) => {
    globalThis.fetch = async () => jsonResponse({
      iid: 42, title: "Choose a pod", description: CRITERION_ISSUE,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42", "--check", "AC-2", "--json",
      ]), 0);
      const parsed = JSON.parse(out.read()).plan;
      assert.equal(parsed.operation.kind, "issue.criterion.toggle");
      assert.deepEqual(parsed.operation.criterion, { id: "AC-2", checked: true });
      const description = parsed.operation.changes.description;
      // Only the targeted bracket moves; indentation and trailing spaces stay.
      assert.match(description, /^- \[x\] AC-2: second$/m);
      assert.match(description, /^- \[ \] AC-1: first {2}$/m);
      assert.match(description, /^- \[x\] AC-3: third$/m);
      // The note states the resulting progress, not the pre-tick count.
      assert.equal(parsed.operation.note, "Marked AC-2 complete (2 of 3).");
      // Concurrent-edit guard captured from the live issue.
      assert.equal(parsed.operation.expectedUpdatedAt, "2026-01-01T00:00:00Z");
      const persisted = JSON.parse(
        readFileSync(join(root, ".oflow", "state", "plans", parsed.id + ".json"), "utf8"),
      );
      assert.equal(persisted.operation.changes.description, description);
    } finally {
      out.restore();
    }
  });
});

test("plan issue update --uncheck reopens a checked criterion and lowers the count", async () => {
  await withCriterionFixture(async (root) => {
    globalThis.fetch = async () => jsonResponse({
      iid: 42, title: "Choose a pod", description: CRITERION_ISSUE,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42", "--uncheck", "AC-3", "--json",
      ]), 0);
      const parsed = JSON.parse(out.read()).plan;
      assert.deepEqual(parsed.operation.criterion, { id: "AC-3", checked: false });
      assert.match(parsed.operation.changes.description, /^- \[ \] AC-3: third$/m);
      // AC-3 was the only checked box, so reopening it leaves none complete.
      assert.equal(parsed.operation.note, "Reopened AC-3 (0 of 3).");
    } finally {
      out.restore();
    }
  });
});

test("plan issue update --check refuses when the criterion is already checked", async () => {
  await withCriterionFixture(async (root) => {
    globalThis.fetch = async () => jsonResponse({
      iid: 42, title: "Choose a pod", description: CRITERION_ISSUE,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42", "--check", "AC-3",
      ]), 1);
    } finally {
      out.restore();
    }
    // A refused command must not leave a plan behind. The plans directory is
    // only created when one is actually written.
    assert.equal(existsSync(join(root, ".oflow", "state", "plans")), false);
  });
});

test("plan issue update --check rejects an unknown criterion and names the valid ids", async () => {
  await withCriterionFixture(async (root) => {
    globalThis.fetch = async () => jsonResponse({
      iid: 42, title: "Choose a pod", description: CRITERION_ISSUE,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const err = captureStderr();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42", "--check", "AC-9",
      ]), 1);
    } finally {
      err.restore();
    }
    const message = err.read();
    assert.match(message, /AC-9/);
    assert.match(message, /AC-1, AC-2, AC-3/);
    // A refused command must not leave a plan behind. The plans directory is
    // only created when one is actually written.
    assert.equal(existsSync(join(root, ".oflow", "state", "plans")), false);
  });
});

test("plan issue update refuses --check combined with other issue edit flags", async () => {
  await withCriterionFixture(async (root) => {
    globalThis.fetch = async () => jsonResponse({
      iid: 42, title: "Choose a pod", description: CRITERION_ISSUE,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const err = captureStderr();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42",
        "--check", "AC-1", "--title", "Renamed",
      ]), 1);
    } finally {
      err.restore();
    }
    assert.match(err.read(), /--title/);
    // A refused command must not leave a plan behind. The plans directory is
    // only created when one is actually written.
    assert.equal(existsSync(join(root, ".oflow", "state", "plans")), false);
  });
});

test("plan issue update refuses --check together with --uncheck", async () => {
  await withCriterionFixture(async (root) => {
    globalThis.fetch = async () => jsonResponse({
      iid: 42, title: "Choose a pod", description: CRITERION_ISSUE,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const err = captureStderr();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42",
        "--check", "AC-1", "--uncheck", "AC-3",
      ]), 1);
    } finally {
      err.restore();
    }
    assert.match(err.read(), /either --check or --uncheck/);
    assert.equal(existsSync(join(root, ".oflow", "state", "plans")), false);
  });
});

test("applying a criterion toggle writes the description then the note, and verifies both", async () => {
  await withCriterionFixture(async (root) => {
    let description = CRITERION_ISSUE;
    const notes = [];
    const order = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method || "GET";
      if (url.endsWith("/issues/42")) {
        if (method === "PUT") {
          order.push("description");
          description = new URLSearchParams(init.body).get("description");
          return jsonResponse({ iid: 42, description, updated_at: "2026-01-02T00:00:00Z" });
        }
        return jsonResponse({ iid: 42, title: "Choose a pod", description, updated_at: "2026-01-01T00:00:00Z" });
      }
      if (url.includes("/issues/42/notes")) {
        if (method === "POST") {
          order.push("note");
          const body = new URLSearchParams(init.body).get("body");
          notes.push({ id: notes.length + 1, body });
          return jsonResponse({ id: notes.length, body });
        }
        return jsonResponse([...notes].reverse());
      }
      throw new Error("unstubbed " + url);
    };
    const out = captureStdout();
    let planPath;
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42", "--check", "AC-2", "--json",
      ]), 0);
      const plan = JSON.parse(out.read()).plan;
      planPath = join(root, ".oflow", "state", "plans", plan.id + ".json");
      assert.equal(await main(["approve", planPath, "--root", root]), 0);
      assert.equal(await main(["apply", planPath, "--root", root]), 0);
      assert.equal(await main(["verify", planPath, "--root", root]), 0);
    } finally {
      out.restore();
    }
    // The note must be created only after the description write succeeds, so a
    // failed tick can never leave a note claiming work that did not happen.
    assert.deepEqual(order, ["description", "note"], "order=" + JSON.stringify(order));
    // The description write landed and the note was created after it.
    assert.match(description, /^- \[x\] AC-2: second$/m);
    assert.deepEqual(notes.map((note) => note.body), ["Marked AC-2 complete (2 of 3)."]);
    const applied = JSON.parse(readFileSync(planPath, "utf8"));
    // The lifecycle ends in `verified`, not `applied`: verify advances the state.
    assert.equal(applied.state, "verified");
    assert.equal(applied.result.noteId, 1);
    assert.deepEqual(applied.result.criterion, { id: "AC-2", checked: true });
  });
});

// A description with a second checklist section. GitLab counts every
// `- [ ]` / `- [x]` bullet when it derives task_completion_status, and a
// positional reference must resolve inside the acceptance section only.
const MULTI_SECTION_ISSUE = [
  "## Tasks",
  "",
  "- [ ] write the migration",
  "- [ ] add the regression test",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] AC-1: first",
  "- [ ] AC-2: second",
  "",
].join("\n");

// Same shape, but the earlier checklist is unlabelled and the acceptance
// section carries explicit ids. A scan that ignores section boundaries would
// count the `## Tasks` bullets first and tick the wrong line.
const EARLY_UNLABELLED_ISSUE = [
  "## Tasks",
  "",
  "- [ ] a",
  "- [ ] b",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] AC-1: first",
  "- [ ] AC-2: second",
  "",
].join("\n");

test("a positional --check never reaches a checklist under an earlier heading", async () => {
  await withCriterionFixture(async (root) => {
    globalThis.fetch = async () => jsonResponse({
      iid: 42, title: "Choose a pod", description: EARLY_UNLABELLED_ISSUE,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42", "--check", "1", "--json",
      ]), 0);
      const parsed = JSON.parse(out.read()).plan;
      assert.equal(parsed.operation.criterion.id, "AC-1");
      assert.match(parsed.operation.changes.description, /^- \[x\] AC-1: first$/m);
      // The earlier unlabelled boxes must be untouched.
      assert.match(parsed.operation.changes.description, /^- \[ \] a$/m);
      assert.match(parsed.operation.changes.description, /^- \[ \] b$/m);
    } finally {
      out.restore();
    }
  });
});

test("a positional --check resolves inside the acceptance section, not an earlier checklist", async () => {
  await withCriterionFixture(async (root) => {
    globalThis.fetch = async () => jsonResponse({
      iid: 42, title: "Choose a pod", description: MULTI_SECTION_ISSUE,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42", "--check", "1", "--json",
      ]), 0);
      const parsed = JSON.parse(out.read()).plan;
      assert.equal(parsed.operation.criterion.id, "AC-1");
      assert.match(parsed.operation.changes.description, /^- \[x\] AC-1: first$/m);
      // The `## Tasks` boxes must be untouched.
      assert.match(parsed.operation.changes.description, /^- \[ \] write the migration$/m);
      assert.match(parsed.operation.changes.description, /^- \[ \] add the regression test$/m);
    } finally {
      out.restore();
    }
  });
});

test("the audit note counts every checklist in the description, the way GitLab does", async () => {
  await withCriterionFixture(async (root) => {
    globalThis.fetch = async () => jsonResponse({
      iid: 42, title: "Choose a pod", description: MULTI_SECTION_ISSUE,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42", "--check", "AC-1", "--json",
      ]), 0);
      const parsed = JSON.parse(out.read()).plan;
      // 1 completed of 4 total checkboxes, not "1 of 2" from the AC section alone.
      assert.equal(parsed.operation.note, "Marked AC-1 complete (1 of 4).");
    } finally {
      out.restore();
    }
  });
});

test("criteria with no AC-n prefix are still addressable by position", async () => {
  const noIds = ["## Acceptance criteria", "", "- [ ] write the migration", "- [ ] add the test", ""].join("\n");
  await withCriterionFixture(async (root) => {
    globalThis.fetch = async () => jsonResponse({
      iid: 42, title: "Choose a pod", description: noIds,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const out = captureStdout();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42", "--check", "2", "--json",
      ]), 0);
      const parsed = JSON.parse(out.read()).plan;
      assert.equal(parsed.operation.criterion.id, "AC-2");
      assert.match(parsed.operation.changes.description, /^- \[x\] add the test$/m);
      assert.match(parsed.operation.changes.description, /^- \[ \] write the migration$/m);
    } finally {
      out.restore();
    }
  });
});

test("--check refuses a criterion id that no line carries", async () => {
  const noIds = ["## Acceptance criteria", "", "- [ ] write the migration", ""].join("\n");
  await withCriterionFixture(async (root) => {
    globalThis.fetch = async () => jsonResponse({
      iid: 42, title: "Choose a pod", description: noIds,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const err = captureStderr();
    try {
      assert.equal(await main([
        "plan", "issue", "update", "--root", root, "--story", "42", "--check", "AC-7",
      ]), 1);
    } finally {
      err.restore();
    }
    // AC-7 is absent, so the id must not silently resolve to an allocated AC-n.
    assert.match(err.read(), /AC-7/);
    // A refused command must not leave a plan behind. The plans directory is
    // only created when one is actually written.
    assert.equal(existsSync(join(root, ".oflow", "state", "plans")), false);
  });
});
