import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { installProject } from "../dist/install.js";

const run = promisify(execFile);

test("install is idempotent and preserves the managed marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-install-"));
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);

    const first = await installProject({ root, agentMode: "both" });
    assert.equal(first.remote.projectPath, "team/product");
    assert.ok(first.files.some((file) => file.path === ".oflow/config.json" && file.action === "created"));

    const second = await installProject({ root, agentMode: "both" });
    assert.ok(second.files.every((file) => file.action === "unchanged"));

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    assert.equal((agents.match(/BEGIN OFLOW MANAGED BLOCK/g) ?? []).length, 1);
    assert.ok(agents.includes("Read .oflow/WORKFLOW.md"));

    const workflow = await readFile(join(root, ".oflow", "WORKFLOW.md"), "utf8");
    assert.ok(workflow.includes("oflow sync --summary --json"));
    assert.ok(workflow.includes("oflow sync --json only when full bounded"));
    assert.ok(workflow.includes("<!-- BEGIN OFLOW CACHE POLICY -->"));
    assert.ok(workflow.includes("If refresh fails, continue local analysis only"));
    assert.ok(workflow.includes("supported writes"));
    assert.ok(workflow.includes("approve, apply, and verify"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install adds the mandatory cache policy to an existing workflow without replacing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-install-policy-"));
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:team/product.git"]);
    await mkdir(join(root, ".oflow"), { recursive: true });
    await writeFile(join(root, ".oflow", "WORKFLOW.md"), "# User workflow\n\nKeep this custom guidance.\n");

    const result = await installProject({ root, agentMode: "codex" });
    const workflow = await readFile(join(root, ".oflow", "WORKFLOW.md"), "utf8");
    assert.ok(result.files.some((file) => file.path === ".oflow/WORKFLOW.md" && file.action === "updated"));
    assert.ok(workflow.includes("Keep this custom guidance."));
    assert.ok(workflow.includes("<!-- BEGIN OFLOW CACHE POLICY -->"));
    assert.ok(workflow.includes("oflow work --mine --cached --json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
