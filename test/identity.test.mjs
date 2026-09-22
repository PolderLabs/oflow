import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  formatIdentityJson,
  formatIdentityMarkdown,
  resolveIdentity,
} from "../dist/identity.js";

// `GitLabClient` reads `process.env.GITLAB_TOKEN` at construction time; the
// resolver constructs one even when no API call is needed. The test token
// is never sent on the wire because every test stubs `globalThis.fetch`.
process.env.GITLAB_TOKEN ||= "oflow-identity-test-token";

const run = promisify(execFile);


/**
 * @param {Partial<{
 *   host: string,
 *   source: "environment" | "stored" | "ci-job-token" | "mcp-runtime" | null,
 *   id: number,
 *   username: string,
 *   email: string | null,
 * }>} overrides
 */


function identity(overrides = {}) {
  return {
    host: "gitlab.example.test",
    source: "stored",
    id: 7,
    username: "alice",
    name: "Alice",
    email: null,
    ...overrides,
  };
}

test("formatIdentityJson: email is omitted-by-default null in the typed object", () => {
  const id = identity({ email: null });
  const parsed = JSON.parse(formatIdentityJson(id));
  assert.equal(parsed.email, null);
  assert.equal(parsed.username, "alice");
  assert.equal(parsed.source, "stored");
});

test("formatIdentityJson: surfaces email only when populated and JSON-stringifies cleanly", () => {
  const id = identity({ email: "alice@example.test" });
  const parsed = JSON.parse(formatIdentityJson(id));
  assert.equal(parsed.email, "alice@example.test");
});

test("formatIdentityMarkdown: prints the not-surfaced hint when email is null", () => {
  const text = formatIdentityMarkdown(identity({ email: null }));
  assert.match(text, /Email: <not surfaced; pass --with-email to opt in/);
  assert.ok(!text.includes("alice@example.test"));
});

test("formatIdentityMarkdown: prints the actual email when set", () => {
  const text = formatIdentityMarkdown(identity({ email: "alice@example.test" }));
  assert.match(text, /^Email: alice@example\.test$/m);
  assert.ok(!text.includes("not surfaced"));
});

test("formatIdentityMarkdown: source=null renders as unknown rather than the literal 'null'", () => {
  const text = formatIdentityMarkdown(identity({ source: null }));
  assert.match(text, /Source: unknown/);
});

test("resolveIdentity: requires .oflow/config.json to be present", async () => {
  await assert.rejects(
    () => resolveIdentity("/nonexistent/never/installed/here"),
    { code: "NOT_INSTALLED" },
  );
});

async function makeTempOflowRepo() {
  const root = await mkdtemp(join(tmpdir(), "oflow-identity-test-"));
  await run("git", ["init", "-q", root]);
  await run("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "git@gitlab.example.test:team/project.git",
  ]);
  await mkdir(join(root, ".oflow"), { recursive: true });
  await writeFile(
    join(root, ".oflow", "config.json"),
    JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }),
  );
  return root;
}

test("resolveIdentity: hides email by default even when GitLab marks it public", async () => {
  const previousFetch = globalThis.fetch;
  const root = await makeTempOflowRepo();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v4/user") {
      return new Response(
        JSON.stringify({
          id: 42,
          username: "alice",
          name: "Alice Liddell",
          email: "alice@example.test",
          public_email: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const id = await resolveIdentity(root, { withEmail: false });
    assert.equal(id.email, null);
    assert.equal(id.username, "alice");
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveIdentity: surfaces public email when withEmail is true", async () => {
  const previousFetch = globalThis.fetch;
  const root = await makeTempOflowRepo();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v4/user") {
      return new Response(
        JSON.stringify({
          id: 42,
          username: "alice",
          name: "Alice Liddell",
          email: "alice@example.test",
          public_email: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const id = await resolveIdentity(root, { withEmail: true });
    assert.equal(id.email, "alice@example.test");
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveIdentity: keeps email null when withEmail is true but public_email is false", async () => {
  const previousFetch = globalThis.fetch;
  const root = await makeTempOflowRepo();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v4/user") {
      return new Response(
        JSON.stringify({
          id: 42,
          username: "alice",
          name: "Alice Liddell",
          email: "alice@example.test",
          public_email: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const id = await resolveIdentity(root, { withEmail: true });
    assert.equal(id.email, null);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});
