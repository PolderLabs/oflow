import assert from "node:assert/strict";
import { test } from "node:test";

import { formatWorkItemSummariesMarkdown } from "../dist/context.js";

// --author maps to author_username, which takes a username and nothing else,
// so the fix is to normalise the value rather than resolve display names. The
// harder half is that a wrong name and a person with no work look identical:
// both render an empty list. These tests pin both halves.

const NONE_FILTERS = { issueLimit: 50, issueFilters: {}, issueState: undefined };

test("an empty result with no identity filter stays a plain message", () => {
  const out = formatWorkItemSummariesMarkdown([], "opened", NONE_FILTERS);
  assert.match(out, /_No work items found\._/);
  // Nothing to disambiguate, so no hedging is warranted.
  assert.doesNotMatch(out, /check the name/);
});

test("an empty result under an author filter says the name may be wrong", () => {
  const out = formatWorkItemSummariesMarkdown([], "opened", {
    issueLimit: 50,
    issueFilters: { author: "alice" },
  });
  assert.match(out, /_No work items found\._/);
  // The whole point: a typo and genuine emptiness are otherwise identical.
  assert.match(out, /No author matched "alice"/);
  assert.match(out, /check the name/);
});

test("an empty result under an assignee filter names the assignee", () => {
  const out = formatWorkItemSummariesMarkdown([], "opened", {
    issueLimit: 50,
    issueFilters: { assignee: "bob" },
  });
  assert.match(out, /No assignee matched "bob"/);
  assert.doesNotMatch(out, /No author matched/);
});

// A non-empty result is not ambiguous: work was found, so no caveat.
test("a non-empty result adds no ambiguity caveat", () => {
  const out = formatWorkItemSummariesMarkdown(
    [{
      iid: 1, title: "Reserve a pod", state: "opened", issueType: "issue",
      labels: [], milestone: null, iteration: null, assignees: ["alice"],
      startDate: null, dueDate: null, weight: null, taskCompletion: null,
      parent: null, updatedAt: null, webUrl: null,
    }],
    "opened",
    { issueLimit: 50, issueFilters: { author: "alice" } },
  );
  assert.match(out, /#1/);
  assert.doesNotMatch(out, /check the name/);
});

// Unrelated filters must not trigger the identity caveat: a project with no
// open issues is a real answer.
test("an empty result under a non-identity filter is not hedged", () => {
  const out = formatWorkItemSummariesMarkdown([], "opened", {
    issueLimit: 50,
    issueFilters: { labels: "ready" },
  });
  assert.match(out, /_No work items found\._/);
  assert.doesNotMatch(out, /check the name/);
});
