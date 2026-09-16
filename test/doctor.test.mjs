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
