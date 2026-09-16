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

test("updates an issue with a form-encoded write request", async () => {
  const originalFetch = globalThis.fetch;
  let requestMethod = "";
  let requestBody = "";
  globalThis.fetch = async (input, init) => {
    requestMethod = init?.method ?? "";
    requestBody = String(init?.body ?? "");
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ iid: 42, title: "Updated story", state: "closed" }),
    };
  };
  try {
    const issue = await new GitLabClient("gitlab.example.test", "test-token")
      .updateIssue("team/project", 42, {
        title: "Updated story",
        labels: "User Story,Ready",
        state_event: "close",
      });
    assert.equal(issue.title, "Updated story");
    assert.equal(requestMethod, "PUT");
    assert.match(requestBody, /title=Updated\+story/);
    const body = new URLSearchParams(requestBody);
    assert.equal(body.get("title"), "Updated story");
    assert.equal(body.get("labels"), "User Story,Ready");
    assert.equal(body.get("state_event"), "close");
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
