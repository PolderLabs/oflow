import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// This repository has no continuous integration and GitHub Actions are disabled
// for it, because Actions usage outgrew what the account plan covers. A
// workflow file under .github/workflows is the one change that would start that
// usage again, silently, on the next push.
//
// The scope is deliberately narrow. `oflow install` writes
// .github/copilot-instructions.md into a user project, so a general `.github`
// assertion would be wrong; only this package's own workflow directory counts.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = join(root, ".github", "workflows");

test("this repository ships no GitHub Actions workflows", () => {
  assert.equal(
    existsSync(workflows),
    false,
    "GitHub Actions are disabled for this repository; adding a workflow under .github/workflows/ would resume the usage that was removed.",
  );
});

test("this repository ships no re-enabling Actions configuration", () => {
  const github = join(root, ".github");
  if (!existsSync(github)) return;
  // .github/dependabot.yml is allowed: Dependabot runs its own jobs on GitHub
  // infrastructure and does not consume Actions minutes.
  assert.deepEqual(
    readdirSync(github).filter((name) => name !== "dependabot.yml"),
    [],
    "Only .github/dependabot.yml may live under .github/ in this repository.",
  );
});