import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
