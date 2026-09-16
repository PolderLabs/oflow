import assert from "node:assert/strict";
import test from "node:test";
import {
  compactMergeRequest,
  compactWorkItems,
  formatMergeRequestMarkdown,
  formatWorkItemsMarkdown,
} from "../dist/context.js";

test("merge request summaries stay compact unless full description is requested", () => {
  const mergeRequest = {
    iid: 8,
    title: "  Review pod access  ",
    description: "acceptance evidence",
    state: "opened",
    draft: true,
    author: { username: "zakar" },
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
    assignees: [{ username: "zakar" }],
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
    assignees: ["zakar"],
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
