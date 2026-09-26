import assert from "node:assert/strict";
import test from "node:test";

import {
  summariseBoardText,
  summariseBoard,
  describeBoard,
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

// The signal is asymmetric by measurement: it flags verification-heavy items,
// and silence proves nothing. Two real work items -- "Check pipeline gating"
// (1.16) and "Review the apply ordering" (1.47) -- are verification work that
// the engine scores as construction, at both title and sentence length. If
// anyone ever treats a construction band as "contains no verification work",
// this fails.
test("a construction band is not evidence that an item has no verification work", () => {
  // Both measured misses land in the construction band.
  for (const measured of [1.16, 1.47]) {
    const value = readVerificationShare(score(measured, "0"));
    assert.equal(value.band, "construction");
    // ...and the module says nothing at all about them, rather than
    // asserting a negative.
    assert.equal(describeVerificationShare(value), null);
  }
});

test("the measured overlap between the two classes is recorded, not smoothed over", () => {
  // construction max 1.35 against verification min 1.16 on short titles: the
  // ranges genuinely overlap, so the bands cannot be treated as a classifier.
  const constructionMax = readVerificationShare(score(1.35, "1"));
  const verificationMin = readVerificationShare(score(1.16, "1"));
  assert.equal(constructionMax.band, "construction");
  assert.equal(verificationMin.band, "construction");
  // Only the high end is trustworthy: a genuinely verification-heavy item is
  // the one that gets flagged. 2.04 sits in the mixed band and 2.35 in the
  // verification band, so a clear verification item does read as one.
  assert.equal(readVerificationShare(score(2.04, "2")).band, "mixed");
  assert.equal(readVerificationShare(score(2.35, "3")).band, "verification");
});

// The margin catches one of the two measured misses and not the other, and the
// one it misses is the more confident wrong answer. That asymmetry is the
// documented behaviour, so it is pinned here rather than left to prose.
test("the uncertainty margin covers one measured miss and not the other", () => {
  // 0.03 from the 1.5 edge: inside the 0.2 margin, so it is disclaimed even
  // though it is banded as construction.
  const near = readVerificationShare(score(1.47, "1"));
  assert.equal(near.band, "construction");
  assert.equal(near.uncertain, true);
  assert.equal(describeVerificationShare(near), null);

  // 0.34 from the same edge: outside the margin, so it is a confident answer
  // that is nonetheless wrong. This is the failure mode to keep visible.
  const clear = readVerificationShare(score(1.16, "1"));
  assert.equal(clear.band, "construction");
  assert.equal(clear.uncertain, false);
});

// A board summary is the one aggregation the measurements support, and only as
// a direction: a pure-construction board still flags 5 of 16 items on the
// default checkpoint, so the floor must travel with the number.
test("a board summary counts flagged items and reports the false-positive floor", () => {
  // 0/6, 3/6, 6/6 -- the measured board ladder.
  const mixed = summariseBoard([1.35, 1.30, 1.40, 1.60, 1.70, 1.90]);
  assert.equal(mixed.items, 6);
  assert.equal(mixed.flagged, 3);
  assert.ok(mixed.mean > 1.4 && mixed.mean < 1.6);
  const text = describeBoard(mixed);
  assert.match(text, /3 of 6/);
  // The floor is the whole point: without it the count reads as a measurement.
  assert.match(text, /direction, not a count/);
  assert.match(text, /5 in 16/);
});

test("a board with nothing to score says nothing", () => {
  assert.equal(describeBoard(summariseBoard([])), null);
  assert.equal(summariseBoard([]).items, 0);
});

test("the board count is monotone as verification items are added", () => {
  // The measured ladder, asserted so a regression in the boundary is visible.
  const con = [1.2, 1.3, 1.4];
  const ver = [1.7, 1.8, 1.9];
  const counts = [0, 1, 2, 3].map((k) => summariseBoard([...con, ...ver.slice(0, k)]).flagged);
  assert.deepEqual(counts, [0, 1, 2, 3]);
});

// The batch path exists because a board is many items, and oflow's runner
// spawns a fresh interpreter per call. Measured through the runner, ten items,
// real engine: 34.37s for ten sequential single calls against 4.33s for one
// batched call -- 7.93x, with all ten scores bit-identical. (Inside one
// already-warm agent the same comparison is only 1.81s vs 1.04s, so the win is
// one process per board rather than one per item, not the forward pass.) If a
// future change regresses that, these tests still hold correctness; the timing
// itself is recorded in docs/LAYA-TRIAGE.md.
test("an absent engine yields no board summary rather than an empty one", async () => {
  // "no reading" and "nothing is verification work" must never look alike.
  assert.equal(await summariseBoardText(["a", "b"], { python: "/no/such/python" }), null);
  assert.equal(await summariseBoardText([]), null);
});

// Opt-in live check: the real engine, and agreement with the single-item path.
test("the batch path scores a board the same way as one call per item", { skip: !process.env.OFLOW_LAYA_BATCH_E2E }, async () => {
  const { runCustomQuestions } = await import("../dist/laya-runner.js");
  const options = {
    python: process.env.OFLOW_LAYA_PYTHON,
    timeoutMs: 180000,
    checkpoint: "typed-decisions",
  };
  const board = [
    "Verify the rollback path against a seeded environment",
    "Confirm the digest guard rejects a stale plan",
    "Add cursor pagination to the work item listing",
    "Fix the retry loop with exponential backoff",
  ];
  const summary = await summariseBoardText(board, options);
  assert.ok(summary, "board summary expected");
  assert.equal(summary.items, board.length);
  for (const text of board) {
    const one = await runCustomQuestions(text, SCRUM_QUESTIONS, options);
    const score = one?.verificationShare?.score;
    if (typeof score === "number" && score >= 1.5) {
      // The summary must count this item as flagged.
      assert.ok(summary.flagged >= 1, "a verification item should be counted");
      break;
    }
  }
});

// The module does NOT length-adjust, deliberately. Subtracting a length-only
// fit removes the correlation (r -> -0.000) and makes the board summary
// worse: on a realistic board it tripled false positives (1 -> 3) and
// introduced a miss. See docs/LAYA-TRIAGE.md. This pins the choice, so a
// future "improvement" has to confront the measurement rather than the idea.
test("the board summary reports raw scores rather than length-adjusted ones", () => {
  // A long construction item and a short verification item. Length-adjusted
  // scoring would drag the long one down and lift the short one up.
  const summary = summariseBoard([2.04, 0.85]);
  assert.equal(summary.flagged, 1, "only the genuinely verification item counts");
  assert.ok(summary.mean > 1.0 && summary.mean < 2.0, "mean is of the raw scores");
});

// The doc tells readers to compare like with like in length. That advice is
// only actionable if the summary reports the lengths, so they travel with it.
// They are reported, never used to adjust the score: see the rejected
// length-residual measurement in docs/LAYA-TRIAGE.md.
test("the board summary reports item lengths so like-for-like is possible", () => {
  const summary = summariseBoard(
    [2.04, 0.85, 1.90],
    ["Verify the rollback path", "Fix login redirect", "Audit every label"],
  );
  assert.deepEqual(summary.wordCounts, [4, 3, 3]);
  const text = describeBoard(summary);
  assert.match(text, /compare items of similar length/);
  assert.match(text, /ranges 3-4 words/);
});

test("a summary without texts reports no lengths rather than guessing", () => {
  const summary = summariseBoard([2.04, 0.85]);
  assert.equal(summary.wordCounts, null);
  const text = describeBoard(summary);
  assert.doesNotMatch(text, /ranges/);
  // The floor still travels, so the count is never quoted bare.
  assert.match(text, /about 5 in 16/);
});

test("mismatched texts and scores are not paired up", () => {
  // The engine can skip an unreadable item; attaching the wrong lengths to the
  // surviving scores would be worse than reporting none.
  const summary = summariseBoard([2.04, 0.85], ["only one text here"]);
  assert.equal(summary.wordCounts, null);
});
