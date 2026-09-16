import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCriteria,
  evidenceFromText,
  parseAcceptanceCriteria,
  parseVerificationEvidence,
} from "../dist/criteria.js";

test("parses stable acceptance criterion ids", () => {
  const criteria = parseAcceptanceCriteria([
    "## Acceptance criteria",
    "- [ ] AC-1: A visitor can choose a pod.",
    "- [x] A visitor can choose a time.",
    "## Notes",
    "- This is not a criterion.",
  ].join("\n"));

  assert.deepEqual(criteria, [
    { id: "AC-1", text: "A visitor can choose a pod.", checked: false },
    { id: "AC-2", text: "A visitor can choose a time.", checked: true },
  ]);
});

test("parses GitLab bold acceptance headings and excludes the next section", () => {
  const criteria = parseAcceptanceCriteria([
    "**User story**",
    "As a visitor, I want a reservation.",
    "**Acceptance criteria**",
    "* [ ] The reservation can be created.",
    "- [x] AC-2: The confirmation is displayed.",
    "**Definition of Done**",
    "* [ ] This is not an acceptance criterion.",
  ].join("\n"));

  assert.deepEqual(criteria, [
    { id: "AC-1", text: "The reservation can be created.", checked: false },
    { id: "AC-2", text: "The confirmation is displayed.", checked: true },
  ]);
});

test("normalizes escaped newlines from imported GitLab descriptions", () => {
  const criteria = parseAcceptanceCriteria(
    "**Acceptance criteria**\\n- [ ] The imported story remains readable.\\n**Notes**\\n- [ ] Not a criterion.",
  );

  assert.deepEqual(criteria, [
    { id: "AC-1", text: "The imported story remains readable.", checked: false },
  ]);
});

test("requires checked MR evidence and a successful pipeline", () => {
  const criteria = parseAcceptanceCriteria([
    "Acceptance criteria",
    "- [ ] The reservation is validated.",
    "- [ ] AC-2: Invalid times are rejected.",
  ].join("\n"));
  const description = [
    "- [x] AC-1: The reservation is validated.",
    "  Evidence: npm test",
    "- [x] AC-2: Invalid times are rejected.",
    "  Evidence: integration test reservation-invalid-time",
  ].join("\n");

  const records = parseVerificationEvidence(description);
  assert.equal(records.get("AC-1").checked, true);
  assert.deepEqual(evidenceFromText("Evidence: TBD"), []);
  assert.equal(evaluateCriteria(criteria, description, "success").passed, true);
  assert.equal(evaluateCriteria(criteria, description, "running").passed, false);
});
