import assert from "node:assert/strict";
import test from "node:test";
import { getCapabilities, formatCapabilitiesMarkdown } from "../dist/capabilities.js";

const DELEGATED_GAP_FIELDS = [
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
  assert.equal(mergeRequestsWrite.backend, "REST + glab + delegated git push");
  const note = mergeRequestsWrite.note ?? "";
  assert.match(note, /delegated path is limited to MR create\/update/i);
  for (const field of DELEGATED_GAP_FIELDS) {
    assert.ok(
      note.includes(field),
      `delegated gap should call out ${field}; note="${note}"`,
    );
  }
});

test("capabilities: markdown surfaces the delegated MR write boundary", async () => {
  const result = await getCapabilities();
  const markdown = formatCapabilitiesMarkdown(result);
  assert.ok(
    markdown.includes("| merge-requests.write |"),
    "markdown should include the merge-requests.write row",
  );
  assert.ok(
    markdown.includes("REST + glab + delegated git push"),
    "markdown should surface the merge-requests.write backend annotation",
  );
  assert.match(markdown, /delegated path is limited to MR create\/update/);
});
