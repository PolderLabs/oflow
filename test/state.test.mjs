import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { resolveOptionalStoryIid } from "../dist/state.js";

const run = promisify(execFile);

test("optional story resolution uses branch context but permits project-only sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-state-"));
  try {
    await run("git", ["init", "-q", root]);
    assert.equal(await resolveOptionalStoryIid(root), undefined);
    await run("git", ["-C", root, "switch", "-c", "story/42"]);
    assert.equal(await resolveOptionalStoryIid(root), 42);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
