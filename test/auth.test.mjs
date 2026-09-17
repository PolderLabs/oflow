import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  clearGitLabToken,
  credentialsPath,
  getGitLabToken,
  getGitLabTokenSource,
  listStoredGitLabHosts,
  saveGitLabToken,
} from "../dist/auth.js";

test("stores host-specific tokens with environment precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-auth-"));
  const previousConfigHome = process.env.OFLOW_CONFIG_HOME;
  const previousToken = process.env.GITLAB_TOKEN;
  const previousAccessToken = process.env.GITLAB_ACCESS_TOKEN;
  const previousPrivateToken = process.env.GITLAB_PRIVATE_TOKEN;
  process.env.OFLOW_CONFIG_HOME = root;
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_ACCESS_TOKEN;
  delete process.env.GITLAB_PRIVATE_TOKEN;

  try {
    await saveGitLabToken("https://GitLab.Example.test/api/v4/", "stored-token");
    assert.equal(getGitLabToken("gitlab.example.test"), "stored-token");
    assert.deepEqual(getGitLabTokenSource("gitlab.example.test"), {
      kind: "stored",
      host: "gitlab.example.test",
      path: credentialsPath(),
    });
    assert.deepEqual(listStoredGitLabHosts(), ["gitlab.example.test"]);
    // Windows enforces file privacy through ACLs and does not expose POSIX
    // mode bits through fs.stat; the Unix mode check remains useful elsewhere.
    if (process.platform !== "win32") {
      assert.equal((await stat(credentialsPath())).mode & 0o777, 0o600);
    }

    await Promise.all([
      saveGitLabToken("gitlab.one.test", "one-token"),
      saveGitLabToken("gitlab.two.test", "two-token"),
    ]);
    assert.equal(getGitLabToken("gitlab.one.test"), "one-token");
    assert.equal(getGitLabToken("gitlab.two.test"), "two-token");
    assert.equal(await clearGitLabToken("gitlab.one.test"), true);
    assert.equal(getGitLabToken("gitlab.two.test"), "two-token");

    assert.equal(getGitLabToken("constructor"), null);
    await saveGitLabToken("constructor", "constructor-token");
    assert.equal(getGitLabToken("constructor"), "constructor-token");
    assert.equal(await clearGitLabToken("constructor"), true);

    await assert.rejects(
      () => saveGitLabToken("gitlab.example.test", "bad\nsecret"),
      { code: "INVALID_GITLAB_TOKEN" },
    );

    process.env.GITLAB_ACCESS_TOKEN = "environment-token";
    assert.equal(getGitLabToken("gitlab.example.test"), "environment-token");
    assert.deepEqual(getGitLabTokenSource("gitlab.example.test"), {
      kind: "environment",
      variable: "GITLAB_ACCESS_TOKEN",
    });

    delete process.env.GITLAB_ACCESS_TOKEN;
    assert.equal(await clearGitLabToken("gitlab.example.test"), true);
    assert.equal(await clearGitLabToken("gitlab.two.test"), true);
    assert.equal(getGitLabToken("gitlab.example.test"), null);
    assert.equal(await clearGitLabToken("gitlab.example.test"), false);
    await assert.rejects(readFile(credentialsPath()), { code: "ENOENT" });

    await writeFile(
      credentialsPath(),
      '{"managedBy":"oflow","version":1,"gitlab":{"gitlab.example.test":"secret-token"',
      "utf8",
    );
    assert.throws(
      () => getGitLabToken("gitlab.example.test"),
      (error) => {
        assert.equal(error.code, "INVALID_CREDENTIALS");
        assert.ok(!error.message.includes("secret-token"));
        return true;
      },
    );
  } finally {
    if (previousConfigHome === undefined) delete process.env.OFLOW_CONFIG_HOME;
    else process.env.OFLOW_CONFIG_HOME = previousConfigHome;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    if (previousAccessToken === undefined) delete process.env.GITLAB_ACCESS_TOKEN;
    else process.env.GITLAB_ACCESS_TOKEN = previousAccessToken;
    if (previousPrivateToken === undefined) delete process.env.GITLAB_PRIVATE_TOKEN;
    else process.env.GITLAB_PRIVATE_TOKEN = previousPrivateToken;
    await rm(root, { recursive: true, force: true });
  }
});
