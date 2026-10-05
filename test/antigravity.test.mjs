import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { detectAgents, normalizeAgentMode } from "../dist/agents.js";
import { installProject } from "../dist/install.js";

const run = promisify(execFile);

async function initGitRepo(root) {
  await run("git", ["init", "-q", root]);
  await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);
}

test("normalizes antigravity agent modes and aliases", () => {
  assert.equal(normalizeAgentMode("antigravity"), "antigravity");
  assert.equal(normalizeAgentMode("ANTIGRAVITY"), "antigravity");
  assert.equal(normalizeAgentMode("agy"), "antigravity");
  assert.equal(normalizeAgentMode("gemini"), "antigravity");
  assert.equal(normalizeAgentMode("auto"), undefined);
});

test("detects Antigravity from project markers, environment, and explicit flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-agy-"));
  const envKey = "ANTIGRAVITY_AGENT";
  const previousEnv = process.env[envKey];
  try {
    // Explicit selection
    const explicit = await detectAgents(root, "antigravity");
    assert.equal(explicit.antigravity, true);
    assert.equal(explicit.mode, "antigravity");
    assert.ok(explicit.signals.antigravity.includes("explicit --agent selection"));

    const aliasExplicit = await detectAgents(root, "agy");
    assert.equal(aliasExplicit.antigravity, true);
    assert.equal(aliasExplicit.mode, "antigravity");

    // Project marker GEMINI.md
    await writeFile(join(root, "GEMINI.md"), "# Antigravity rules\n");
    const markerDetection = await detectAgents(root);
    assert.equal(markerDetection.antigravity, true);
    assert.ok(markerDetection.signals.antigravity.includes("GEMINI.md"));

    // Project marker .agents
    await mkdir(join(root, ".agents"), { recursive: true });
    const agentsDirDetection = await detectAgents(root);
    assert.equal(agentsDirDetection.antigravity, true);
    assert.ok(agentsDirDetection.signals.antigravity.includes(".agents directory"));

    // Environment variable detection
    process.env[envKey] = "1";
    const fresh = await mkdtemp(join(tmpdir(), "oflow-agy-env-"));
    const envDetection = await detectAgents(fresh);
    assert.equal(envDetection.antigravity, true);
    assert.ok(envDetection.signals.antigravity.includes("ANTIGRAVITY_AGENT environment"));
    await rm(fresh, { recursive: true, force: true });
  } finally {
    if (previousEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = previousEnv;
    await rm(root, { recursive: true, force: true });
  }
});

test("install writes GEMINI.md and the Antigravity skill idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-agy-install-"));
  try {
    await initGitRepo(root);
    await writeFile(
      join(root, "GEMINI.md"),
      "# Custom Rules\n\nPreserve these team rules.\n",
    );

    const first = await installProject({ root, agentMode: "antigravity" });
    const agyFiles = first.files.filter(
      (file) => file.path === "GEMINI.md" || file.path.startsWith(".agents/"),
    );
    assert.deepEqual(
      agyFiles.map((file) => file.path).sort(),
      [
        ".agents/skills/oflow/SKILL.md",
        "GEMINI.md",
      ],
    );

    // Verify GEMINI.md contents & preserved user content
    const gemini = await readFile(join(root, "GEMINI.md"), "utf8");
    assert.match(gemini, /Preserve these team rules\./);
    assert.match(gemini, /BEGIN OFLOW MANAGED BLOCK/);
    assert.match(gemini, /oflow instructions for Antigravity/);
    assert.match(gemini, /oflow work --mine --refresh --json/);

    // Verify .agents/skills/oflow/SKILL.md frontmatter and structure
    const skill = await readFile(join(root, ".agents", "skills", "oflow", "SKILL.md"), "utf8");
    assert.ok(skill.startsWith("---\nname: oflow\n"));
    assert.match(skill, /# oflow: GitLab-First Agent Workflow/);
    assert.match(skill, /Mandatory cache policy/);
    assert.match(skill, /Story lifecycle/);

    // Rerunning install is idempotent
    const second = await installProject({ root, agentMode: "antigravity" });
    for (const file of second.files.filter(
      (f) => f.path === "GEMINI.md" || f.path.startsWith(".agents/"),
    )) {
      assert.equal(file.action, "unchanged", file.path + " should be unchanged on rerun");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
