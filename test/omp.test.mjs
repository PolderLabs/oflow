import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { detectAgents } from "../dist/agents.js";
import { installProject } from "../dist/install.js";
import { setupOmpGitLabMcp, ompGitLabMcpConfigured } from "../dist/omp-mcp.js";

const run = promisify(execFile);

async function initGitRepo(root) {
  await run("git", ["init", "-q", root]);
  await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);
}

test("detects OMP from project markers, environment, and PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-omp-"));
  const previousProfile = process.env.OMP_PROFILE;
  try {
    await mkdir(join(root, ".omp", "commands"), { recursive: true });
    const detection = await detectAgents(root, "omp");
    assert.equal(detection.omp, true);
    assert.ok(detection.signals.omp.includes("explicit --agent selection"));

    process.env.OMP_PROFILE = "default";
    const fresh = await mkdtemp(join(tmpdir(), "oflow-omp-env-"));
    const envDetection = await detectAgents(fresh);
    assert.equal(envDetection.omp, true);
    assert.ok(envDetection.signals.omp.includes("OMP_PROFILE environment"));
    await rm(fresh, { recursive: true, force: true });
  } finally {
    if (previousProfile === undefined) delete process.env.OMP_PROFILE;
    else process.env.OMP_PROFILE = previousProfile;
    await rm(root, { recursive: true, force: true });
  }
});

test("install writes the OMP bridge and slash commands idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-omp-install-"));
  try {
    await initGitRepo(root);
    await writeFile(
      join(root, "AGENTS.md"),
      "# User notes\n\nKeep my content.\n",
    );
    const first = await installProject({ root, agentMode: "omp" });
    const ompFiles = first.files.filter((file) => file.path.startsWith(".omp/"));
    assert.deepEqual(
      ompFiles.map((file) => file.path).sort(),
      [
        ".omp/AGENTS.md",
        ".omp/commands/oflow-handoff.md",
        ".omp/commands/oflow-start.md",
        ".omp/commands/oflow-status.md",
        ".omp/commands/oflow-verify.md",
      ],
    );

    const bridge = await readFile(join(root, ".omp", "AGENTS.md"), "utf8");
    assert.match(bridge, /oflow project workflow/);
    assert.match(bridge, /workflow authority/);

    const start = await readFile(join(root, ".omp", "commands", "oflow-start.md"), "utf8");
    assert.match(start, /description: Start or continue the correct oflow-managed work/);
    assert.match(start, /oflow start --json/);

    // User-authored content outside the managed block is preserved.
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /Keep my content\./);

    // Rerunning install is safe.
    const second = await installProject({ root, agentMode: "omp" });
    for (const file of second.files.filter((f) => f.path.startsWith(".omp/"))) {
      assert.equal(file.action, "unchanged", file.path + " should be unchanged on rerun");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project-local GitLab MCP setup writes no secrets and merges safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-omp-mcp-"));
  const remote = { host: "gitlab.example.test", projectPath: "team/project", remoteUrl: "x" };
  try {
    const created = await setupOmpGitLabMcp(root, remote, false);
    assert.equal(created.action, "created");
    const raw = await readFile(join(root, ".omp", "mcp.json"), "utf8");
    const config = JSON.parse(raw);
    assert.equal(config.mcpServers.GitLab.url, "https://gitlab.example.test/api/v4/mcp");
    assert.equal(config.mcpServers.GitLab.type, "http");
    // No token or secret anywhere in the file.
    assert.equal(/token|secret/i.test(raw), false);
    assert.equal(await ompGitLabMcpConfigured(root, remote), true);

    // Idempotent.
    const rerun = await setupOmpGitLabMcp(root, remote, false);
    assert.equal(rerun.action, "unchanged");

    // Existing unrelated servers are preserved.
    await writeFile(
      join(root, ".omp", "mcp.json"),
      JSON.stringify({ mcpServers: { Context7: { type: "http", url: "https://context7.test/mcp" } } }),
    );
    const merged = await setupOmpGitLabMcp(root, remote, false);
    assert.equal(merged.action, "updated");
    const after = JSON.parse(await readFile(join(root, ".omp", "mcp.json"), "utf8"));
    assert.ok(after.mcpServers.Context7, "existing server preserved");
    assert.equal(after.mcpServers.GitLab.url, "https://gitlab.example.test/api/v4/mcp");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a conflicting GitLab MCP entry is reported, never overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-omp-mcp-"));
  const remote = { host: "gitlab.example.test", projectPath: "team/project", remoteUrl: "x" };
  try {
    await mkdir(join(root, ".omp"), { recursive: true });
    await writeFile(
      join(root, ".omp", "mcp.json"),
      JSON.stringify({
        mcpServers: { GitLab: { type: "http", url: "https://other.example.test/api/v4/mcp" } },
      }),
    );
    const result = await setupOmpGitLabMcp(root, remote, false);
    assert.equal(result.action, "conflict");
    const after = JSON.parse(await readFile(join(root, ".omp", "mcp.json"), "utf8"));
    assert.equal(
      after.mcpServers.GitLab.url,
      "https://other.example.test/api/v4/mcp",
      "user config untouched",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
