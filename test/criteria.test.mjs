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

