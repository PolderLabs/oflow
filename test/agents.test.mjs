import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { detectAgents } from "../dist/agents.js";

test("detects Claude and Codex project markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-agents-"));
  try {
    await writeFile(join(root, "CLAUDE.md"), "# Claude");
    await mkdir(join(root, ".codex"));
    const detection = await detectAgents(root);
    assert.equal(detection.claude, true);
    assert.equal(detection.codex, true);
    assert.equal(detection.mode, "both");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

