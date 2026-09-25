import assert from "node:assert/strict";
import test from "node:test";
import { getCapabilities, formatCapabilitiesMarkdown } from "../dist/capabilities.js";

const DIRECT_ISSUE_FIELDS = [
  "labels",
  "milestone_id",
  "epic_id",
  "due_date",
  "weight",
  "issue_type",
  "assignee_ids",
];

test("capabilities: merge-requests.write annotates the delegated field scope", async () => {
  const result = await getCapabilities();
  const mergeRequestsWrite = result.capabilities.find(
    (capability) => capability.id === "merge-requests.write",
  );
  assert.ok(mergeRequestsWrite, "merge-requests.write capability missing");
  assert.equal(mergeRequestsWrite.access, "apply");
  assert.equal(mergeRequestsWrite.backend, "direct REST plus delegated create");
  const note = mergeRequestsWrite.note ?? "";
  const normalisedNote = note.replace(/\s+/g, " ");
  assert.match(normalisedNote, /direct execution supports MR create\/update/i);
  assert.match(normalisedNote, /apply --delegate.*MR create only/i);
  assert.match(normalisedNote, /delegated MR update is not implemented/i);
  assert.match(normalisedNote, /git push.*separate Git transport fallback/i);
  for (const field of DIRECT_ISSUE_FIELDS) {
    assert.equal(normalisedNote.includes(field), false, `MR capability should not imply issue field ${field}`);
  }
});

test("capabilities: markdown surfaces the delegated MR write boundary", async () => {
  const result = await getCapabilities();
  const markdown = formatCapabilitiesMarkdown(result);
  const normalisedMarkdown = markdown.replace(/\s+/g, " ");
  assert.ok(
    normalisedMarkdown.includes("| merge-requests.write |"),
    "markdown should include the merge-requests.write row",
  );
  assert.ok(
    normalisedMarkdown.includes("direct REST plus delegated create"),
    "markdown should surface the merge-requests.write backend annotation",
  );
  assert.match(normalisedMarkdown, /apply --delegate.*MR create only/i);
  assert.match(normalisedMarkdown, /delegated MR update is not implemented/i);
});
