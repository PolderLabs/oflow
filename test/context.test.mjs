import assert from "node:assert/strict";
import test from "node:test";
import { compactWorkItems, formatWorkItemsMarkdown } from "../dist/context.js";

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
