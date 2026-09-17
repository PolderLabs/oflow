import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { glabApiGet } from "../dist/glab.js";

test("glab fallback performs a read-only JSON API request without a token argument", {
  // The fake executable is a POSIX shebang script; the real glab binary is a
  // native executable on Windows and is still covered by the CLI smoke path.
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-glab-"));
  const previousBinary = process.env.OFLOW_GLAB_BIN;
  const script = join(root, "fake-glab.mjs");
  await writeFile(
    script,
    [
      "#!/usr/bin/env node",
      "import { argv } from 'node:process';",
      "console.log(JSON.stringify({ args: argv.slice(2) }));",
    ].join("\n"),
  );
  await chmod(script, 0o755);
  process.env.OFLOW_GLAB_BIN = script;
  try {
    const result = await glabApiGet({
      root,
      host: "gitlab.example.test",
      endpoint: "/projects/team%2Fproject/releases",
    });
    assert.deepEqual(result, {
      args: [
        "api",
        "--hostname",
        "gitlab.example.test",
        "--method",
        "GET",
        "projects/team%2Fproject/releases",
        "--output",
        "json",
      ],
    });
  } finally {
    if (previousBinary === undefined) delete process.env.OFLOW_GLAB_BIN;
    else process.env.OFLOW_GLAB_BIN = previousBinary;
    await rm(root, { recursive: true, force: true });
  }
});

test("glab fallback rejects non-read-only endpoint input", async () => {
  await assert.rejects(
    () => glabApiGet({ root: ".", host: "gitlab.example.test", endpoint: "https://evil.test" }),
    { code: "UNSAFE_GLAB_ENDPOINT" },
  );
});
