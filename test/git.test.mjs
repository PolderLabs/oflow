import assert from "node:assert/strict";
import test from "node:test";
import { parseGitRemote, slugify } from "../dist/git.js";

test("parses GitLab SSH and HTTPS remotes", () => {
  assert.deepEqual(parseGitRemote("git@gitlab.com:team/product.git"), {
    host: "gitlab.com",
    projectPath: "team/product",
    remoteUrl: "git@gitlab.com:team/product.git",
  });
  assert.equal(
    parseGitRemote("https://gitlab.example.com/group/subgroup/product.git").projectPath,
    "group/subgroup/product",
  );
});

test("slugifies project labels", () => {
  assert.equal(slugify("Epic 2 / Reservation Management"), "epic-2-reservation-management");
});

test("rejects remotes with embedded credentials without echoing them", () => {
  assert.throws(
    () => parseGitRemote("https://oauth2:secret-token@gitlab.example.test/team/project.git"),
    (error) => {
      assert.equal(error.code, "EMBEDDED_REMOTE_CREDENTIALS");
      assert.ok(!error.message.includes("secret-token"));
      return true;
    },
  );
});
