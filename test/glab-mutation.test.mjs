import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { glabApiMutation } from "../dist/glab.js";

test("glab mutation transport sends argv fields and parses JSON", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-glab-mutation-"));
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
    const result = await glabApiMutation({
      root,
      host: "gitlab.example.test",
      endpoint: "/projects/team%2Fproject/issues/42",
      method: "PUT",
      fields: { labels: "In Progress" },
    });
    assert.deepEqual(result, {
      args: [
        "api",
        "--hostname",
        "gitlab.example.test",
        "--method",
        "PUT",
        "projects/team%2Fproject/issues/42",
        "--output",
        "json",
        "--field",
        "labels=In Progress",
      ],
    });
  } finally {
    if (previousBinary === undefined) delete process.env.OFLOW_GLAB_BIN;
    else process.env.OFLOW_GLAB_BIN = previousBinary;
    await rm(root, { recursive: true, force: true });
  }
});

test("glab mutation transport rejects unsafe endpoints like reads", async () => {
  await assert.rejects(
    () =>
      glabApiMutation({
        root: ".",
        host: "gitlab.example.test",
        endpoint: "https://evil.test",
        method: "POST",
      }),
    { code: "UNSAFE_GLAB_ENDPOINT" },
  );
});

test("glab mutation transport tolerates empty responses", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-glab-mutation-"));
  const previousBinary = process.env.OFLOW_GLAB_BIN;
  const script = join(root, "fake-glab.mjs");
  await writeFile(script, ["#!/usr/bin/env node", ""].join("\n"));
  await chmod(script, 0o755);
  process.env.OFLOW_GLAB_BIN = script;
  try {
    const result = await glabApiMutation({
      root,
      host: "gitlab.example.test",
      endpoint: "projects/1/issues/42/notes",
      method: "POST",
      fields: { body: "progress note" },
    });
    assert.equal(result, null);
  } finally {
    if (previousBinary === undefined) delete process.env.OFLOW_GLAB_BIN;
    else process.env.OFLOW_GLAB_BIN = previousBinary;
    await rm(root, { recursive: true, force: true });
  }
});
