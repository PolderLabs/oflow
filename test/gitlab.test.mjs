import assert from "node:assert/strict";
import test from "node:test";
import { GitLabClient } from "../dist/gitlab.js";

test("rejects non-JSON project responses from the GitLab API", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => "<html>sign in</html>",
  });
  try {
    await assert.rejects(
      () => new GitLabClient("gitlab.example.test", "test-token").getProject("team/project"),
      { code: "INVALID_GITLAB_RESPONSE" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lists project work items by state", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify([{ iid: 42, title: "Choose a pod" }]),
    };
  };
  try {
    const issues = await new GitLabClient("gitlab.example.test", "test-token")
      .listIssues("team/project", "opened");
    assert.deepEqual(issues, [{ iid: 42, title: "Choose a pod" }]);
    assert.match(requestUrl, /\/projects\/team%2Fproject\/issues\?state=opened&per_page=100/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("redacts tokens from API errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    headers: new Headers(),
    text: async () => "x".repeat(280) + "sensitive-token",
  });
  try {
    await assert.rejects(
      () => new GitLabClient("gitlab.example.test", "sensitive-token").getProject("team/project"),
      (error) => {
        assert.equal(error.code, "GITLAB_API_ERROR");
        assert.ok(!error.message.includes("sensitive-token"));
        assert.ok(error.message.includes("[REDACTED]"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
