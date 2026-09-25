import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadPlanArtifact } from "../dist/plan.js";

// The traversal guard is exercised through the public plan loader: it is the
// function every plan command resolves a caller-supplied path with, and it
// refuses an out-of-root path before it inspects the artifact.
const REFUSAL = /must point to \.oflow\/state\/plans/;

const artifact = (over = {}) =>
  JSON.stringify({
    managedBy: "oflow",
    version: 2,
    id: "p1",
    state: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    digest: "abc123",
    operation: {
      kind: "issue.update",
      host: "gitlab.example.test",
      projectPath: "team/p",
      issueIid: 1,
      changes: { add_labels: ["a"] },
    },
    ...over,
  });

const seed = (prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  const planDir = join(root, ".oflow", "state", "plans");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "p1.json"), artifact());
  return { root, planDir };
};

test("a plan path spelled differently but naming the same file is accepted", async (t) => {
  // git rev-parse and the filesystem can spell one directory two ways on
  // Windows (8.3 short name, separator style, trailing separator). These all
  // name the same file inside the plan root and must not read as traversal.
  const { root, planDir } = seed("oflow-spelling-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const spelling of [
    join(root, ".oflow", "state", "plans", "p1.json"),
    root + "/" + ".oflow/state/plans/p1.json",
    join(root + "/", ".oflow", "state", "plans", "p1.json"),
    planDir + "/p1.json",
    join(planDir, "..", "plans", "p1.json"),
  ]) {
    const loaded = await loadPlanArtifact(root, spelling);
    assert.equal(loaded.plan.id, "p1",
      "must load the same plan for an equivalent spelling: " + spelling);
  }
});

test("a plan path that escapes the plan root is refused", async (t) => {
  const { root } = seed("oflow-traversal-");
  const outside = mkdtempSync(join(tmpdir(), "oflow-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(root, "evil.json"), artifact({ id: "evil" }));
  writeFileSync(join(outside, "evil.json"), artifact({ id: "evil" }));
  writeFileSync(join(root, ".oflow", "state", "plans", "p1.txt"), artifact({ id: "evil" }));

  for (const escape of [
    join(root, "evil.json"),
    join(root, ".oflow", "state", "plans", "..", "..", "..", "evil.json"),
    join(root, ".oflow", "state", "plans", "..", "evil.json"),
    join(outside, "evil.json"),
    join(root, ".oflow", "state", "plans"),
    join(root, ".oflow", "state", "plans", "p1.txt"),
  ]) {
    await assert.rejects(
      () => loadPlanArtifact(root, escape),
      (e) => REFUSAL.test(String((e && e.message) || e)),
      "must refuse: " + escape,
    );
  }
});

test("a plan reached through a different path to the same directory is accepted", { skip: process.platform === "win32" }, async (t) => {
  // A symlink gives one directory a second name, the same situation the
  // Windows 8.3 short form creates: `root` and the plan path spell the same
  // directory differently, so the lexical check alone reads the difference as
  // a ".." chain and refuses a path that never left the plan root.
  const { root } = seed("oflow-alias-");
  const aliasParent = mkdtempSync(join(tmpdir(), "oflow-alias-parent-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(aliasParent, { recursive: true, force: true });
  });

  const alias = join(aliasParent, "alias");
  symlinkSync(root, alias, "junction");

  const loaded = await loadPlanArtifact(root,
    join(alias, ".oflow", "state", "plans", "p1.json"));
  assert.equal(loaded.plan.id, "p1",
    "must accept a plan reached through an alias of the same directory");
});
