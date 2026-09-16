import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    assert.ok(workflow.includes("oflow sync when available"));
    assert.ok(workflow.includes("Do not use planned commands until oflow capabilities"));
    assert.ok(workflow.includes("plan -> approve -> apply -> verify"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
