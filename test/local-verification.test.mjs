import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  currentTreeDigest,
  getLocalVerificationStatus,
  runLocalVerification,
} from "../dist/local-verification.js";

const run = promisify(execFile);

async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), "oflow-local-verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run("git", ["init", "-q", root]);
  await run("git", ["-C", root, "config", "user.email", "test@example.test"]);
  await run("git", ["-C", root, "config", "user.name", "Test User"]);
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await run("git", ["-C", root, "add", "."]);
  await run("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

const required = {
  policy: "required",
  checks: [{ id: "node-version", command: [process.execPath, "--version"] }],
};

test("local verification binds a successful argv check to the current tree", async (t) => {
  const root = await repo(t);
  const result = await runLocalVerification(root, required);
  assert.equal(result.status, "passed");
  assert.equal(result.targetDigest, await currentTreeDigest(root));
  assert.equal(result.perCheck[0].exitCode, 0);
  const status = await getLocalVerificationStatus(root, required);
  assert.equal(status.state, "passed");
  assert.equal(status.passed, true);
  assert.equal(status.blocking, false);
});

test("required verification becomes stale after an uncommitted tree change", async (t) => {
  const root = await repo(t);
  await runLocalVerification(root, required);
  await writeFile(join(root, "tracked.txt"), "changed\n");
  const status = await getLocalVerificationStatus(root, required);
  assert.equal(status.state, "stale");
  assert.equal(status.blocking, true);
});

test("legacy unconfigured verification is visible but non-blocking", async (t) => {
  const root = await repo(t);
  const status = await getLocalVerificationStatus(root, undefined);
  assert.equal(status.state, "unconfigured");
  assert.equal(status.passed, false);
  assert.equal(status.blocking, false);
});

test("required empty verification contract is non-closeable", async (t) => {
  const root = await repo(t);
  const status = await getLocalVerificationStatus(root, { policy: "required", checks: [] });
  assert.equal(status.state, "configured");
  assert.equal(status.blocking, true);
});

test("verification rejects credential-like command arguments", async (t) => {
  const root = await repo(t);
  await assert.rejects(
    () => runLocalVerification(root, {
      policy: "required",
      checks: [{ id: "bad", command: [process.execPath, "--token=secret"] }],
    }),
    (error) => error?.code === "INVALID_VERIFICATION_CHECK",
  );
});
