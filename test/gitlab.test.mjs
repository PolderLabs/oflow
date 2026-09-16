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

test("reads one merge request by project-local IID", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ iid: 8, title: "Review pod access", state: "opened" }),
    };
  };
  try {
    const mergeRequest = await new GitLabClient("gitlab.example.test", "test-token")
      .getMergeRequest("team/project", 8);
    assert.equal(mergeRequest.iid, 8);
    assert.match(requestUrl, /\/projects\/team%2Fproject\/merge_requests\/8$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applies server-side work-item filters without downloading descriptions", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify([]),
    };
  };
  try {
    await new GitLabClient("gitlab.example.test", "test-token")
      .listIssues("team/project", "opened", 7, {
        label: "User Story",
        milestone: "Sprint 1",
        iteration: "none",
        epic: "12",
        assignee: "zakar,alice",
        author: "zakar",
        search: "pod",
        updatedAfter: "2026-01-01T00:00:00Z",
      });
    const query = new URL(requestUrl).searchParams;
    assert.equal(query.get("state"), "opened");
    assert.equal(query.get("per_page"), "7");
    assert.equal(query.get("scope"), "all");
    assert.equal(query.get("labels"), "User Story");
    assert.equal(query.get("milestone"), "Sprint 1");
    assert.equal(query.get("iteration_id"), "None");
    assert.equal(query.get("iteration_title"), null);
    assert.equal(query.get("epic_id"), "12");
    assert.deepEqual(query.getAll("assignee_username[]"), ["zakar", "alice"]);
    assert.equal(query.get("author_username"), "zakar");
    assert.equal(query.get("search"), "pod");
    assert.equal(query.get("updated_after"), "2026-01-01T00:00:00Z");
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
        add_labels: "backend",
        remove_labels: "stale",
        state_event: "close",
      });
    assert.equal(issue.title, "Updated story");
    assert.equal(requestMethod, "PUT");
    assert.match(requestBody, /title=Updated\+story/);
    const body = new URLSearchParams(requestBody);
    assert.equal(body.get("title"), "Updated story");
    assert.equal(body.get("labels"), "User Story,Ready");
    assert.equal(body.get("add_labels"), "backend");
    assert.equal(body.get("remove_labels"), "stale");
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
