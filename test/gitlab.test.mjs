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

test("reads the authenticated GitLab user", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ id: 7, username: "zakar", name: "Zakar" }),
    };
  };
  try {
    const user = await new GitLabClient("gitlab.example.test", "test-token")
      .getCurrentUser();
    assert.deepEqual(user, { id: 7, username: "zakar", name: "Zakar" });
    assert.equal(requestUrl, "https://gitlab.example.test/api/v4/user");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports GitLab pagination headers without fetching another page", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return {
      ok: true,
      status: 200,
      headers: new Headers({
        "x-page": "1",
        "x-next-page": "2",
        "x-total": "8",
        "x-total-pages": "3",
        link: '<https://gitlab.example.test/api/v4/projects/team%2Fproject/issues?page=2>; rel="next"',
      }),
      text: async () => JSON.stringify([{ iid: 42, title: "Choose a pod" }]),
    };
  };
  try {
    const page = await new GitLabClient("gitlab.example.test", "test-token")
      .listIssuesPage("team/project", "opened", 3);
    assert.match(requestUrl, /per_page=3/);
    assert.deepEqual(page.items, [{ iid: 42, title: "Choose a pod" }]);
    assert.deepEqual(page.pagination, {
      returned: 1,
      requested: 3,
      page: 1,
      nextPage: 2,
      total: 8,
      totalPages: 3,
      hasNextPage: true,
    });
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

test("lists pipelines through the merge-request-scoped endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify([{ id: 10, status: "success", sha: "head-sha" }]),
    };
  };
  try {
    const pipelines = await new GitLabClient("gitlab.example.test", "test-token")
      .listMergeRequestPipelines("team/project", 8);
    assert.deepEqual(pipelines, [{ id: 10, status: "success", sha: "head-sha" }]);
    assert.match(requestUrl, /\/projects\/team%2Fproject\/merge_requests\/8\/pipelines\?per_page=20$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lists iteration cadences through the bounded GraphQL query", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://gitlab.example.test/api/graphql");
    requestBody = String(init?.body ?? "");
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({
        data: {
          group: {
            iterationCadences: {
              nodes: [{
                id: "gid://gitlab/Iterations::Cadence/1",
                title: "Two-week sprints",
                active: true,
                automatic: true,
                durationInWeeks: 2,
                iterationsInAdvance: 2,
                rollOver: false,
                startDate: "2026-09-14T00:00:00Z",
              }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      }),
    };
  };
  try {
    const result = await new GitLabClient("gitlab.example.test", "test-token")
      .listIterationCadences("team", 5);
    const body = JSON.parse(requestBody);
    assert.match(body.query, /iterationCadences\(includeAncestorGroups: true, first: \$first\)/);
    assert.deepEqual(body.variables, { fullPath: "team", first: 5 });
    assert.deepEqual(result, {
      cadences: [{
        id: "gid://gitlab/Iterations::Cadence/1",
        title: "Two-week sprints",
        active: true,
        automatic: true,
        duration_in_weeks: 2,
        iterations_in_advance: 2,
        roll_over: false,
        start_date: "2026-09-14T00:00:00Z",
      }],
      mayBeTruncated: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sets and clears an issue iteration through the guarded GraphQL mutation", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  let responseBody = JSON.stringify({
    data: {
      issueSetIteration: {
        errors: [],
        issue: { iid: "42" },
      },
    },
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://gitlab.example.test/api/graphql");
    requestBody = String(init?.body ?? "");
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => responseBody,
    };
  };
  try {
    const client = new GitLabClient("gitlab.example.test", "test-token");
    const assigned = await client.setIssueIteration(
      "team/project",
      42,
      "gid://gitlab/Iteration/53",
    );
    assert.deepEqual(assigned, { iid: 42 });
    const body = JSON.parse(requestBody);
    assert.match(body.query, /issueSetIteration\(input: \$input\)/);
    assert.deepEqual(body.variables, {
      input: {
        projectPath: "team/project",
        iid: "42",
        iterationId: "gid://gitlab/Iteration/53",
      },
    });

    responseBody = JSON.stringify({
      data: {
        issueSetIteration: {
          errors: [],
          issue: { iid: "42" },
        },
      },
    });
    assert.deepEqual(await client.setIssueIteration("team/project", 42, null), { iid: 42 });
    assert.equal(JSON.parse(requestBody).variables.input.iterationId, null);

    responseBody = JSON.stringify({
      data: {
        issueSetIteration: {
          errors: ["Iteration is not visible to this project"],
          issue: null,
        },
      },
    });
    await assert.rejects(
      () => client.setIssueIteration("team/project", 42, "gid://gitlab/Iteration/53"),
      { code: "GITLAB_ITERATION_UPDATE_FAILED" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lists group epics through the bounded Work Item GraphQL query", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestMethod = "";
  let requestBody = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestMethod = init?.method ?? "";
    requestBody = String(init?.body ?? "");
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({
        data: {
          group: {
            workItems: {
              nodes: [
                {
                  id: "gid://gitlab/WorkItem/123",
                iid: "7",
                title: "Reservations",
                state: "OPENED",
                webUrl: "https://gitlab.example.test/groups/team/-/epics/7",
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-7" },
            },
          },
        },
      }),
    };
  };
  try {
    const result = await new GitLabClient("gitlab.example.test", "test-token")
      .listGroupEpics("team", 10);
    assert.equal(requestUrl, "https://gitlab.example.test/api/graphql");
    assert.equal(requestMethod, "POST");
    const body = JSON.parse(requestBody);
    assert.match(body.query, /workItems\(types: \[EPIC\], first: \$first\)/);
    assert.deepEqual(body.variables, { fullPath: "team", first: 10 });
    assert.deepEqual(result.epics, [{
      id: "gid://gitlab/WorkItem/123",
      iid: 7,
      title: "Reservations",
      state: "OPENED",
      web_url: "https://gitlab.example.test/groups/team/-/epics/7",
    }]);
    assert.equal(result.mayBeTruncated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reads a group epic hierarchy and rejects GraphQL errors", async () => {
  const originalFetch = globalThis.fetch;
  let responseBody = JSON.stringify({
    data: {
      namespace: {
        workItem: {
          id: "gid://gitlab/WorkItem/123",
          iid: "7",
          title: "Reservations",
          state: "OPENED",
          webUrl: "https://gitlab.example.test/groups/team/-/epics/7",
          widgets: [
            {
              __typename: "WorkItemWidgetHierarchy",
              parent: {
                id: "gid://gitlab/WorkItem/100",
                iid: "3",
                title: "Product",
                webUrl: "https://gitlab.example.test/groups/team/-/epics/3",
                workItemType: { name: "Epic" },
              },
              children: {
                nodes: [{
                  id: "gid://gitlab/WorkItem/124",
                  iid: "8",
                  title: "Booking flow",
                  webUrl: "https://gitlab.example.test/groups/team/-/epics/8",
                  workItemType: { name: "Epic" },
                }],
              },
            },
          ],
        },
      },
    },
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => responseBody,
  });
  try {
    const epic = await new GitLabClient("gitlab.example.test", "test-token")
      .getGroupEpic("team", 7);
    assert.deepEqual(epic, {
      id: "gid://gitlab/WorkItem/123",
      iid: 7,
      title: "Reservations",
      state: "OPENED",
      web_url: "https://gitlab.example.test/groups/team/-/epics/7",
      parent: {
        id: "gid://gitlab/WorkItem/100",
        iid: 3,
            title: "Product",
            web_url: "https://gitlab.example.test/groups/team/-/epics/3",
            type: "Epic",
          },
      children: [{
        id: "gid://gitlab/WorkItem/124",
        iid: 8,
          title: "Booking flow",
          web_url: "https://gitlab.example.test/groups/team/-/epics/8",
          type: "Epic",
        }],
    });

    responseBody = JSON.stringify({
      errors: [{ message: "Group work items are unavailable" }],
    });
    await assert.rejects(
      () => new GitLabClient("gitlab.example.test", "test-token").listGroupEpics("team", 10),
      { code: "GITLAB_API_ERROR" },
    );
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
        updatedBefore: "2026-02-01T00:00:00Z",
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
    assert.equal(query.get("updated_before"), "2026-02-01T00:00:00Z");
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
