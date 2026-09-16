import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const cli = join(process.cwd(), "dist", "cli.js");

test("auth set accepts stdin and status never prints the token", () => {
  const configHome = mkdtempSync(join(tmpdir(), "oflow-cli-"));
  const environment = { ...process.env, OFLOW_CONFIG_HOME: configHome };
  try {
    const saved = execFileSync(
      process.execPath,
      [cli, "auth", "set", "--host", "gitlab.example.test", "--token-stdin", "--json"],
      { env: environment, input: "secret-token\n", encoding: "utf8" },
    );
    assert.match(saved, /"action": "saved"/);
    assert.ok(!saved.includes("secret-token"));

    const status = execFileSync(
      process.execPath,
      [cli, "auth", "status", "--host", "gitlab.example.test", "--json"],
      { env: environment, encoding: "utf8" },
    );
    assert.match(status, /"activeSource": "stored"/);
    assert.ok(!status.includes("secret-token"));
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("auth rejects token command-line arguments without echoing the value", () => {
  const result = spawnSync(
    process.execPath,
    [cli, "auth", "set", "--host", "gitlab.example.test", "--token", "secret-token"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Do not pass GitLab tokens as command-line arguments/);
  assert.ok(!result.stderr.includes("secret-token"));
});

test("CLI runs through a symlink like an npm global binary", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "oflow-bin-"));
  const linkedCli = join(directory, "oflow");
  try {
    symlinkSync(cli, linkedCli);
    const result = execFileSync(linkedCli, ["help"], { encoding: "utf8" });
    assert.match(result, /^oflow - GitLab-first workflow/);
    assert.match(result, /filters: --label, --milestone, --iteration, --epic, --assignee, --author/);
    assert.match(result, /epic \[--iid <iid>\] \[--limit <n>\]/);
    assert.match(result, /sync --epics/);
    assert.match(result, /mr --iid <iid> \[--full\] \[--json\]/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
