import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// This repository has no continuous integration and GitHub Actions are disabled
// for it, because Actions usage outgrew what the account plan covers. A
// workflow file under .github/workflows is the one change that would start that
// usage again, silently, on the next push.
//
// The scope is deliberately narrow, and it mirrors the AGENTS.md rule exactly:
// only workflow files are prohibited. `oflow install` writes
// .github/copilot-instructions.md into a user project, and issue or pull-request
// templates, CODEOWNERS, or FUNDING.yml under .github are not CI.
//
// The assertion is on contents, not on the directory: git does not track empty
// directories, so a leftover local .github/workflows folder must not fail the
// build. An absent or unreadable directory counts as no workflows.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function workflowFiles() {
  let entries;
  try {
    entries = readdirSync(join(root, ".github", "workflows"));
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
}

test("this repository ships no GitHub Actions workflows", () => {
  assert.deepEqual(
    workflowFiles(),
    [],
    "GitHub Actions are disabled for this repository; a workflow under .github/workflows/ would resume the removed usage.",
  );
});