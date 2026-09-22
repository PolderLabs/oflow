import assert from "node:assert/strict";
import test from "node:test";
import {
  compactMergeRequest,
  compactWorkItems,
  formatMergeRequestMarkdown,
  formatWorkItemTypeCoverageWarning,
  formatWorkItemsMarkdown,
  selectVerificationEvidence,
} from "../dist/context.js";

test("type-coverage warning names the exact hidden count", () => {
  const text = formatWorkItemTypeCoverageWarning({ graphqlCount: 132, restTotal: 95, hiddenCount: 37 });
  assert.match(text, /37 of 132 project work items are invisible/);
  assert.match(text, /User Story or EPIC/);
  assert.match(text, /not complete/);
});

test("merge request summaries stay compact unless full description is requested", () => {
  const mergeRequest = {
    iid: 8,
    title: "  Review pod access  ",
    description: "acceptance evidence",
    state: "opened",
    draft: true,
    author: { username: "test-user" },
    assignees: [{ username: "alice" }],
    reviewers: [{ name: "Bob" }],
    labels: ["review"],
    source_branch: "feature/access",
    target_branch: "dev",
    detailed_merge_status: "ci_still_running",
    pipeline: { status: "running" },
    updated_at: "2026-01-01T00:00:00Z",
    web_url: "https://gitlab.example.test/team/project/-/merge_requests/8",
  };
  const summary = compactMergeRequest(mergeRequest);
  assert.equal("description" in summary, false);
  assert.equal(summary.pipelineStatus, "running");
  assert.match(formatMergeRequestMarkdown(summary), /Merge status: ci_still_running/);
  assert.equal(compactMergeRequest(mergeRequest, true).description, "acceptance evidence");
});

test("work items compact away descriptions while preserving planning state", () => {
  const [item] = compactWorkItems([{
    iid: 23,
    title: "  Verify the supported XLOCK integration path  ",
    description: "large acceptance criteria body",
    state: "opened",
    labels: ["User Story"],
    assignees: [{ username: "test-user" }],
    milestone: { title: "Sprint 1" },
    iteration: { title: "Iteration 1" },
    parent: { iid: 4, title: "Access control", web_url: "https://gitlab.example.test/parent/4" },
    updated_at: "2026-01-01T00:00:00Z",
    web_url: "https://gitlab.example.test/team/project/-/issues/23",
  }]);

  assert.deepEqual(item, {
    iid: 23,
    title: "Verify the supported XLOCK integration path",
    state: "opened",
    labels: ["User Story"],
    milestone: "Sprint 1",
    iteration: "Iteration 1",
    assignees: ["test-user"],
    startDate: null,
    dueDate: null,
    weight: null,
    taskCompletion: null,
    parent: {
      iid: 4,
      title: "Access control",
      webUrl: "https://gitlab.example.test/parent/4",
    },
    updatedAt: "2026-01-01T00:00:00Z",
    webUrl: "https://gitlab.example.test/team/project/-/issues/23",
  });
  assert.equal("description" in item, false);
});

test("work markdown reports the effective bounded query", () => {
  const markdown = formatWorkItemsMarkdown(
    [{
      iid: 23,
      title: "Verify the supported XLOCK integration path",
      labels: ["User Story"],
      web_url: "https://gitlab.example.test/team/project/-/issues/23",
    }],
    "opened",
    {
      issueLimit: 1,
      issueFilters: { label: "User Story", assignee: "none" },
      mayBeTruncated: true,
    },
  );

  assert.match(markdown, /Query: opened; limit 1; filters: label="User Story", assignee="none"/);
  assert.match(markdown, /Count: 1 \(more may exist\)/);
});

test("verification selects the branch MR and matching head pipeline", () => {
  const evidence = selectVerificationEvidence({
    branch: "feature/pod",
    mergeRequests: [
      { iid: 7, title: "Old pod work", source_branch: "feature/old", sha: "old-head" },
      { iid: 8, title: "Current pod work", source_branch: "feature/pod", sha: "current-head" },
    ],
    mergeRequestPipelines: [
      { id: 70, status: "success", sha: "old-head" },
      { id: 80, status: "success", sha: "current-head" },
    ],
  });

  assert.equal(evidence.mergeRequest.iid, 8);
  assert.equal(evidence.pipeline.id, 80);
  assert.equal(evidence.warning, null);
});

test("verification refuses ambiguous merge requests", () => {
  const evidence = selectVerificationEvidence({
    branch: null,
    mergeRequests: [
      { iid: 7, title: "First pod work" },
      { iid: 8, title: "Second pod work" },
    ],
    mergeRequestPipelines: [{ id: 80, status: "success" }],
  });

  assert.equal(evidence.mergeRequest, null);
  assert.equal(evidence.pipeline, null);
  assert.match(evidence.warning, /Could not identify one related merge request/);
});
