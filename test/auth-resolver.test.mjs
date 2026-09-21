import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolveAuth, detectRuntimeGitLabMcp } from "../dist/auth-resolver.js";
import { isCanonicalActionName } from "../dist/actions.js";

test("canonical action names are recognized across planning, delivery, and workflow", () => {
  assert.equal(isCanonicalActionName("work_item.update"), true);
  assert.equal(isCanonicalActionName("merge_request.create"), true);
  assert.equal(isCanonicalActionName("workflow.start"), true);
  assert.equal(isCanonicalActionName("issue.update"), false);
});

test("environment token wins read backend priority over glab and store", async () => {
  const previous = process.env.GITLAB_TOKEN;
  const previousGlab = process.env.OFLOW_GLAB_BIN;
  process.env.GITLAB_TOKEN = "glpat-env-test";
  const root = await mkdtemp(join(tmpdir(), "oflow-authresolver-"));
  try {
    const resolution = await resolveAuth({
      host: "gitlab.example.test",
      root,
      glabBinary: join(root, "missing-glab"),
    });
    assert.equal(resolution.authenticated, true);
    assert.equal(resolution.readBackend, "rest");
    const environment = resolution.sources.find((s) => s.source === "environment");
    assert.equal(environment?.authenticated, true);
    assert.ok(
      environment?.notes?.[0].includes("Environment token detected"),
      "notes must name the detected variable without echoing its value",
    );
  } finally {
    if (previous === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previous;
    if (previousGlab === undefined) delete process.env.OFLOW_GLAB_BIN;
    else process.env.OFLOW_GLAB_BIN = previousGlab;
    await rm(root, { recursive: true, force: true });
  }
});

test("authenticated glab wins when no environment token exists", { skip: process.platform === "win32" }, async () => {
  const previous = process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_TOKEN;
  const root = await mkdtemp(join(tmpdir(), "oflow-authresolver-"));
  const script = join(root, "fake-glab.mjs");
  await writeFile(
    script,
    [
      "#!/usr/bin/env node",
      "import { argv } from 'node:process';",
      "const args = argv.slice(2);",
      "if (args[0] === 'auth' && args[1] === 'status') process.exit(0);",
      "if (args[0] === '--version') { console.log('glab version 1.2.3'); process.exit(0); }",
      "process.exit(1);",
    ].join("\n"),
  );
  await chmod(script, 0o755);
  try {
    const resolution = await resolveAuth({
      host: "gitlab.example.test",
      root,
      glabBinary: script,
    });
    const glab = resolution.sources.find((s) => s.source === "glab");
    assert.equal(glab?.authenticated, true);
    assert.equal(resolution.readBackend, "glab");
    assert.equal(resolution.mutationBackend, "glab");
  } finally {
    if (previous === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-owned GitLab MCP config is detected but never counts as CLI-authenticated", async () => {
  const previous = process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_TOKEN;
  const root = await mkdtemp(join(tmpdir(), "oflow-authresolver-"));
  await mkdir(join(root, ".omp"), { recursive: true });
  await writeFile(
    join(root, ".omp", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        GitLab: { type: "http", url: "https://gitlab.example.test/api/v4/mcp" },
      },
    }),
  );
  try {
    const detection = await detectRuntimeGitLabMcp(root, "gitlab.example.test");
    assert.deepEqual(detection, { configured: true, source: ".omp/mcp.json" });

    const resolution = await resolveAuth({
      host: "gitlab.example.test",
      root,
      glabBinary: join(root, "missing-glab"),
    });
    const mcp = resolution.sources.find((s) => s.source === "mcp-runtime");
    assert.equal(mcp?.authenticated, "runtime-owned");
    // Reduced mode: no CLI read transport, so reads stay unavailable even
    // though an MCP config exists.
    assert.equal(resolution.readBackend, "none");
    assert.equal(resolution.mutationBackend, "gitlab-mcp");
  } finally {
    if (previous === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("no credential sources leaves backends unavailable", async () => {
  const previous = process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_TOKEN;
  const root = await mkdtemp(join(tmpdir(), "oflow-authresolver-"));
  try {
    const resolution = await resolveAuth({
      host: "gitlab.example.test",
      root,
      glabBinary: join(root, "missing-glab"),
    });
    assert.equal(resolution.authenticated, false);
    assert.equal(resolution.readBackend, "none");
    assert.equal(resolution.mutationBackend, "none");
  } finally {
    if (previous === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previous;
    await rm(root, { recursive: true, force: true });
  }
});
