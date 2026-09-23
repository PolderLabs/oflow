import assert from "node:assert/strict";
import test from "node:test";
import {
  convertBulletsToAcceptanceCriteria,
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

test("treats Done when bullets as acceptance criteria when no checklist heading exists", () => {
  const criteria = parseAcceptanceCriteria([
    "## Done when",
    "- the door locks on close",
    "- the alarm sounds on forced entry",
    "## Notes",
    "- not a criterion",
  ].join("\n"));
  assert.deepEqual(criteria, [
    { id: "AC-1", text: "the door locks on close", checked: false },
    { id: "AC-2", text: "the alarm sounds on forced entry", checked: false },
  ]);
});

test("prefers an explicit Acceptance criteria heading over Done when", () => {
  const criteria = parseAcceptanceCriteria([
    "## Done when",
    "- ignored fallback",
    "## Acceptance criteria",
    "- [ ] real criterion",
  ].join("\n"));
  assert.deepEqual(criteria, [
    { id: "AC-1", text: "real criterion", checked: false },
  ]);
});

test("converts eligible plain bullets into stable checklist criteria", () => {
  const conversion = convertBulletsToAcceptanceCriteria([
    "## Done when",
    "- locks on close",
    "- [x] already checked",
  ].join("\n"));
  assert.equal(conversion.changed, true);
  assert.equal(conversion.converted, 1);
  assert.match(conversion.description, /- \[ \] AC-1: locks on close/);
  assert.match(conversion.description, /- \[x\] already checked/);
});

test("preserves unique explicit IDs and reallocates duplicates during conversion", () => {
  const conversion = convertBulletsToAcceptanceCriteria([
    "## Done when",
    "- AC-7: first condition",
    "- AC-7: second condition",
    "- condition without an ID",
  ].join("\n"));
  assert.equal(conversion.changed, true);
  assert.equal(conversion.converted, 3);
  assert.match(conversion.description, /- \[ \] AC-7: first condition/);
  assert.match(conversion.description, /- \[ \] AC-1: second condition/);
  assert.match(conversion.description, /- \[ \] AC-2: condition without an ID/);
  assert.deepEqual(
    parseAcceptanceCriteria(conversion.description).map((criterion) => criterion.id),
    ["AC-7", "AC-1", "AC-2"],
  );
});

test("does nothing when there is no acceptance section", () => {
  const original = "- just some notes\n- more notes";
  const conversion = convertBulletsToAcceptanceCriteria(original);
  assert.equal(conversion.changed, false);
  assert.equal(conversion.description, original);
});

test("pipeline policy: disabled always satisfies the pipeline gate", () => {
  const criteria = parseAcceptanceCriteria([
    "Acceptance criteria",
    "- [ ] The reservation is validated.",
  ].join("\n"));
  const description = [
    "- [x] AC-1: The reservation is validated.",
    "  Evidence: npm test",
  ].join("\n");
  assert.equal(
    evaluateCriteria(criteria, description, null, { pipelinePolicy: "disabled" }).passed,
    true,
  );
  assert.equal(
    evaluateCriteria(criteria, description, "failed", { pipelinePolicy: "disabled" }).passed,
    true,
  );
});

test("pipeline policy: absent CI config with no pipeline evidence warns instead of blocking", () => {
  const criteria = parseAcceptanceCriteria([
    "Acceptance criteria",
    "- [ ] The reservation is validated.",
  ].join("\n"));
  const description = [
    "- [x] AC-1: The reservation is validated.",
    "  Evidence: npm test",
  ].join("\n");
  const result = evaluateCriteria(criteria, description, null, {
    pipelinePolicy: "enabled",
    ciConfigPresent: false,
  });
  assert.equal(result.passed, true);
  assert.match(result.reasons.join("\n"), /no \.gitlab-ci\.yml/);
});

test("pipeline policy: enabled with present CI and no pipeline still blocks", () => {
  const criteria = parseAcceptanceCriteria([
    "Acceptance criteria",
    "- [ ] The reservation is validated.",
  ].join("\n"));
  const description = [
    "- [x] AC-1: The reservation is validated.",
    "  Evidence: npm test",
  ].join("\n");
  const result = evaluateCriteria(criteria, description, null, {
    pipelinePolicy: "enabled",
    ciConfigPresent: true,
  });
  assert.equal(result.passed, false);
  assert.match(result.reasons.join("\n"), /latest pipeline is unknown/);
});
