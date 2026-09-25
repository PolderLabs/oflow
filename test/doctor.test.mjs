import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { doctor, formatDoctor } from "../dist/doctor.js";

const run = promisify(execFile);

test("doctor reports optional backend status without requiring glab", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-doctor-"));
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);

    const report = await doctor(root);

    assert.equal(report.backends.rest.available, true);
    assert.equal(report.backends.rest.role, "core");
    assert.equal(report.backends.glab.role, "optional-fallback");
    assert.equal(report.backends.mcp.available, false);
    assert.equal(report.backends.mcp.role, "agent-runtime");

    const output = formatDoctor(report);
    assert.ok(output.includes("Backends:"));
    assert.ok(output.includes("REST: available (core)"));
    assert.ok(output.includes("MCP: agent-runtime optional"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor probes bounded read capabilities and never probes writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-doctor-api-"));
  const previousToken = process.env.GITLAB_TOKEN;
  const originalFetch = globalThis.fetch;
  const methods = [];
  process.env.GITLAB_TOKEN = "test-token";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    methods.push({ method: init?.method ?? "GET", url, body: String(init?.body ?? "") });
    let body = [];
    if (url.endsWith("/user")) {
      body = { id: 7, username: "test-user" };
    } else if (url.endsWith("/personal_access_tokens/self")) {
      body = { scopes: ["api", "read_api"], active: true, revoked: false, expires_at: null };
    } else if (url.endsWith("/projects/team%2Fproduct")) {
      body = { id: 11, path_with_namespace: "team/product", web_url: "https://gitlab.com/team/product" };
    } else if (url.includes("/boards?")) {
      body = [{ id: 9, name: "Planning" }];
    } else if (url.includes("/api/graphql")) {
      const query = JSON.parse(String(init?.body ?? "{}")).query;
      body = {
        data: {
          group: query.includes("iterationCadences")
            ? { iterationCadences: { nodes: [], pageInfo: { hasNextPage: false } } }
            : { workItems: { nodes: [], pageInfo: { hasNextPage: false } } },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(body),
    };
  };

  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);

    const report = await doctor(root, { checkApi: true });
    assert.equal(report.apiCheck, "passed");
    for (const id of [
      "project.read",
      "user.read",
      "work-items.read",
      "merge-requests.read",
      "pipelines.read",
      "labels.read",
      "milestones.read",
      "boards.read",
      "board-lists.read",
      "iterations.read",
    ]) {
      assert.equal(
        report.apiChecks.find((check) => check.id === id)?.status,
        "passed",
        id,
      );
    }
    assert.equal(
      report.apiChecks.find((check) => check.id === "group-epics.read")?.status,
      "passed",
    );
    assert.equal(
      report.apiChecks.find((check) => check.id === "work-items.update")?.status,
      "not-probed",
    );
    const tokenCheck = report.apiChecks.find((check) => check.id === "token.scopes");
    assert.equal(tokenCheck?.status, "passed");
    assert.ok(tokenCheck?.detail.includes("api, read_api"));
    assert.ok(typeof tokenCheck?.latencyMs === "number");
    assert.ok(formatDoctor(report).includes("token.scopes"));
    assert.ok(
      report.apiChecks
        .filter((check) => check.status === "passed" && check.latencyMs !== undefined)
        .every((check) => check.latencyMs >= 0),
    );
    assert.ok(methods.every((request) =>
      request.method === "GET" || !request.body.includes("mutation"),
    ));

    const output = formatDoctor(report);
    assert.ok(output.includes("API capability checks (read probes only; no remote writes):"));
    assert.ok(output.includes("[PASS] REST work-items.read"));
    assert.ok(output.includes("[N/A] REST work-items.update"));
    assert.ok(output.includes("Write check policy: doctor never tests a mutation."));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) {
      delete process.env.GITLAB_TOKEN;
    } else {
      process.env.GITLAB_TOKEN = previousToken;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor reports token scope probing as skipped when the PAT endpoint is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-doctor-pat-"));
  const previousToken = process.env.GITLAB_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.GITLAB_TOKEN = "test-token";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/personal_access_tokens/self")) {
      return {
        ok: false,
        status: 403,
        headers: new Headers(),
        text: async () => JSON.stringify({ message: "403 Forbidden" }),
      };
    }
    let body = [];
    if (url.endsWith("/user")) {
      body = { id: 7, username: "test-user" };
    } else if (url.endsWith("/projects/team%2Fproduct")) {
      body = { id: 11, path_with_namespace: "team/product", web_url: "https://gitlab.com/team/product" };
    } else if (url.includes("/boards?")) {
      body = [{ id: 9, name: "Planning" }];
    } else if (url.includes("/api/graphql")) {
      body = { data: { group: { workItems: { nodes: [], pageInfo: { hasNextPage: false } } } } };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(body),
    };
  };

  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);
    const report = await doctor(root, { checkApi: true });
    const tokenCheck = report.apiChecks.find((check) => check.id === "token.scopes");
    assert.equal(tokenCheck?.status, "skipped");
    assert.ok(tokenCheck?.detail.includes("unavailable"));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) {
      delete process.env.GITLAB_TOKEN;
    } else {
      process.env.GITLAB_TOKEN = previousToken;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor --check-api maps apiChecks to report.capabilities without re-probing", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-doctor-cap-"));
  const previousToken = process.env.GITLAB_TOKEN;
  const originalFetch = globalThis.fetch;
  const methods = [];
  process.env.GITLAB_TOKEN = "test-token";
  globalThis.fetch = async (input, init) => {
    methods.push({ method: init?.method ?? "GET", url: String(input) });
    const url = String(input);
    let body = [];
    if (url.endsWith("/user")) {
      body = { id: 7, username: "test-user" };
    } else if (url.endsWith("/personal_access_tokens/self")) {
      body = { scopes: ["api", "read_api"], active: true, revoked: false, expires_at: null };
    } else if (url.endsWith("/projects/team%2Fproduct")) {
      body = { id: 11, path_with_namespace: "team/product", web_url: "https://gitlab.com/team/product" };
    } else if (url.includes("/boards?")) {
      body = [{ id: 9, name: "Planning" }];
    } else if (url.includes("/api/graphql")) {
      body = { data: { group: { workItems: { nodes: [], pageInfo: { hasNextPage: false } }, iterationCadences: { nodes: [], pageInfo: { hasNextPage: false } } } } };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(body),
    };
  };
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);
    const report = await doctor(root, { checkApi: true });
    assert.ok(Array.isArray(report.capabilities));
    const ids = report.capabilities.map((cap) => cap.id);
    for (const expected of ["project.read", "user.read", "work-items.read", "work-items.update"]) {
      assert.ok(ids.includes(expected), "missing capability " + expected);
    }
    const write = report.capabilities.find((cap) => cap.id === "work-items.update");
    assert.equal(write.probe, "not-probed");
    assert.equal(write.usable, false, "writes are only usable when the MCP runtime is present");
    const read = report.capabilities.find((cap) => cap.id === "project.read");
    assert.equal(read.usable, true);
    assert.equal(read.probe, "passed");
    // No additional probes beyond what checkApiCapabilities needs.
    assert.ok(methods.length > 0);
    assert.ok(methods.length < 30, "expected bounded probe count, got " + methods.length);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor surfaces 401 remediation hint in apiChecks detail", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-doctor-401-"));
  const previousToken = process.env.GITLAB_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.GITLAB_TOKEN = "stale-token";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/user")) {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response(JSON.stringify({ id: 1, path_with_namespace: "team/product" }));
  };
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);
    const report = await doctor(root, { checkApi: true });
    assert.equal(report.apiCheck, "failed");
    const userCheck = report.apiChecks.find((check) => check.id === "user.read");
    assert.equal(userCheck?.status, "failed");
    assert.ok(userCheck?.detail);
    assert.match(userCheck.detail, /401|oflow auth login/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor --check-api marks writes usable when the MCP runtime is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-doctor-mcp-"));
  const previousToken = process.env.GITLAB_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.GITLAB_TOKEN = "test-token";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/user")) return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ id: 7, username: "test-user" }) };
    if (url.endsWith("/personal_access_tokens/self")) return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ scopes: ["api"], active: true, revoked: false, expires_at: null }) };
    if (url.endsWith("/projects/team%2Fproduct")) return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ id: 11, path_with_namespace: "team/product", web_url: "https://gitlab.com/team/product" }) };
    if (url.includes("/boards?")) return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify([{ id: 9, name: "Planning" }]) };
    if (url.includes("/api/graphql")) return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: { group: { workItems: { nodes: [], pageInfo: { hasNextPage: false } }, iterationCadences: { nodes: [], pageInfo: { hasNextPage: false } } } } }) };
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({}) };
  };
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);
    await mkdir(join(root, ".omp"), { recursive: true });
    await writeFile(join(root, ".omp/mcp.json"), JSON.stringify({
      servers: [{ name: "gitlab", url: "https://gitlab.com/api/v4/mcp" }],
    }));
    const report = await doctor(root, { checkApi: true });
    const write = report.capabilities.find((cap) => cap.id === "work-items.update");
    assert.equal(write.probe, "not-probed");
    assert.equal(write.usable, true, "writes become usable when MCP runtime is configured");
    assert.equal(write.source, "mcp-runtime");
    assert.equal(write.backend, "gitlab-mcp");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor merge-requests.write row names the apply path (no stale 'no apply path yet' text)", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-doctor-mrwrite-"));
  const previousToken = process.env.GITLAB_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.GITLAB_TOKEN = "test-token";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    let body = [];
    if (url.endsWith("/user")) {
      body = { id: 7, username: "test-user" };
    } else if (url.endsWith("/personal_access_tokens/self")) {
      body = { scopes: ["api", "read_api"], active: true, revoked: false, expires_at: null };
    } else if (url.endsWith("/projects/team%2Fproduct")) {
      body = { id: 11, path_with_namespace: "team/product", web_url: "https://gitlab.com/team/product" };
    } else if (url.includes("/boards?")) {
      body = [{ id: 9, name: "Planning" }];
    } else if (url.includes("/api/graphql")) {
      const query = JSON.parse(String(init?.body ?? "{}")).query;
      body = {
        data: {
          group: query.includes("iterationCadences")
            ? { iterationCadences: { nodes: [], pageInfo: { hasNextPage: false } } }
            : { workItems: { nodes: [], pageInfo: { hasNextPage: false } } },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(body),
    };
  };
  try {
    await run("git", ["init", "-q", root]);
    await run("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "git@gitlab.com:team/product.git",
    ]);

    const report = await doctor(root, { checkApi: true });
    const row = report.apiChecks.find((check) => check.id === "merge-requests.write");
    assert.ok(row, "doctor must name merge-requests.write in its write checks");
    assert.equal(row.access, "write");
    assert.equal(row.backend, "REST + GraphQL");
    assert.equal(row.required, false);
    assert.equal(row.status, "not-probed");
    assert.ok(
      !/no merge-request apply path yet/.test(row.detail),
      "the stale 'no apply path yet' copy must be gone",
    );
    assert.match(
      row.detail,
      /REST\s*\+\s*glab\s*\+\s*delegated git push/,
      "doctor must list all three transports in the merge-requests.write detail",
    );

    const output = formatDoctor(report);
    assert.ok(output.includes("merge-requests.write"));
    assert.ok(!output.includes("no merge-request apply path yet"));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("a fine-grained token without User: Read is not a total API failure", async () => {
  // A real failure mode: a fine-grained personal access token that can read
  // the project but lacks User: Read. Only `work --mine` needs the actor, and
  // pipelines degrade gracefully, so the headline must not report a total
  // failure while the read commands work. The individual checks must still
  // surface their own failure so the missing scope stays visible.
  const root = await mkdtemp(join(tmpdir(), "oflow-doctor-fine-"));
  const previousToken = process.env.GITLAB_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.GITLAB_TOKEN = "fine-grained-test-token";
  globalThis.fetch = async (input) => {
    const url = String(input);
    const forbidden = url.endsWith("/user") || url.includes("/pipelines?");
    return {
      ok: !forbidden,
      status: forbidden ? 403 : 200,
      headers: new Headers(),
      text: async () =>
        JSON.stringify(
          forbidden
            ? {
                error: "insufficient_granular_scope",
                error_description: "Access denied: requires [User: Read].",
              }
            : { id: 1, path_with_namespace: "team/product", default_branch: "main" },
        ),
    };
  };

  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);

    const report = await doctor(root, { checkApi: true });

    assert.equal(
      report.apiCheck,
      "passed",
      "a token that can read the project is not a total API failure",
    );
    // The scope gap must remain visible, not be swallowed by the headline.
    assert.equal(report.apiChecks.find((c) => c.id === "user.read")?.status, "failed");
    assert.equal(report.apiChecks.find((c) => c.id === "pipelines.read")?.status, "failed");
    assert.ok(
      report.warnings.some((w) => w.includes("user.read")),
      "the failed check must still be reported as a warning",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable project is still reported as a total API failure", async () => {
  // The counterpart: if project.read itself fails, every read path is broken
  // and the headline must say so.
  const root = await mkdtemp(join(tmpdir(), "oflow-doctor-noread-"));
  const previousToken = process.env.GITLAB_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.GITLAB_TOKEN = "unreadable-test-token";
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    headers: new Headers(),
    text: async () => JSON.stringify({ message: "403 Forbidden" }),
  });

  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);

    const report = await doctor(root, { checkApi: true });
    assert.equal(report.apiCheck, "failed");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
