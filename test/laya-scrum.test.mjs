import assert from "node:assert/strict";
import test from "node:test";

import {
  SCRUM_QUESTIONS,
  VERIFICATION_SHARE,
  readVerificationShare,
  describeVerificationShare,
} from "../dist/laya-scrum.js";

// Only the question that survived calibration is exported. The band reader is
// the part that reaches a human, so its boundaries and its uncertainty flag
// are what these tests pin.

const score = (value, top) => ({ verificationShare: { type: "score", score: value, top, probabilities: {} } });

test("only the calibrated question set is exported", () => {
  // executorFit and specificationGap were implemented, measured, and dropped.
  // A test keeps them from creeping back in as defaults.
  assert.deepEqual(Object.keys(SCRUM_QUESTIONS), ["verificationShare"]);
  assert.equal(VERIFICATION_SHARE.type, "score");
  assert.equal(VERIFICATION_SHARE.criteria.length, 4);
  // The question must name the variable the runner substitutes.
  assert.match(VERIFICATION_SHARE.instructions, /`request`/);
});

test("low scores read as construction and say nothing", () => {
  const value = readVerificationShare(score(0.6, "0"));
  assert.equal(value.band, "construction");
  // Construction is the ordinary case; hedging it on every story is noise.
  assert.equal(describeVerificationShare(value), null);
});

test("a high score reads as verification work and is worth saying", () => {
  const value = readVerificationShare(score(2.6, "3"));
  assert.equal(value.band, "verification");
  assert.equal(describeVerificationShare(value), "mostly verification and evidence work");
});

test("a middle score reads as mixed", () => {
  const value = readVerificationShare(score(1.9, "2"));
  assert.equal(value.band, "mixed");
  assert.equal(describeVerificationShare(value), "partly verification and evidence work");
});

// The engine's confidence is uncalibrated, so the band is the only thing a
// caller sees. It must not be rounded away at a boundary.
test("a score on a band edge is marked uncertain and stays silent", () => {
  for (const edge of [1.5, 2.3]) {
    const value = readVerificationShare(score(edge, "1"));
    assert.equal(value.uncertain, true, "edge " + edge);
    assert.equal(describeVerificationShare(value), null, "edge " + edge);
  }
});

test("a score away from an edge is not uncertain", () => {
  assert.equal(readVerificationShare(score(2.7, "3")).uncertain, false);
  assert.equal(readVerificationShare(score(0.4, "0")).uncertain, false);
});

test("no signal and weak signal are both silence", () => {
  assert.equal(readVerificationShare(null), null);
  assert.equal(readVerificationShare({}), null);
  assert.equal(readVerificationShare({ verificationShare: null }), null);
  assert.equal(describeVerificationShare(null), null);
  // A noul answer is a different question type, not a weak score.
  assert.equal(readVerificationShare({ verificationShare: { type: "noul", noul: 0.4 } }), null);
  assert.equal(readVerificationShare({ verificationShare: { type: "score", score: "high" } }), null);
});
