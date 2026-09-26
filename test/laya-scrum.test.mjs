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
  process.env.OFLOW_LAYA_SCRUM_UNCALIBRATED = "1";
  let summary;
  try {
    summary = await summariseBoardText(board, options);
  } finally {
    delete process.env.OFLOW_LAYA_SCRUM_UNCALIBRATED;
  }
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

// The like-for-like caveat matters most when the board is mixed, which is what
// a real sprint board is: short construction items beside long verification
// ones. A 3-4 word spread does not exercise the rendering.
test("a widely mixed board renders its full length range", () => {
  const summary = summariseBoard(
    [2.04, 0.85, 1.90, 0.60, 2.10],
    [
      "Fix login redirect",
      "Audit every label for unused or duplicated coverage across the whole project",
      "Verify the rollback procedure restores the previous release exactly",
      "Bump deps",
      "Confirm the acceptance criteria still parse after the criteria refactor",
    ],
  );
  assert.deepEqual(summary.wordCounts, [3, 12, 9, 2, 10]);
  const text = describeBoard(summary);
  assert.match(text, /ranges 2-12 words/);
  // A wide spread is exactly when the reader needs the warning most.
  assert.match(text, /compare items of similar length/);
});

// The index -> text mapping is only exercised when the engine cannot answer
// one item. This drives the real summariseBoardText with a stubbed engine
// that returns one unreadable entry among two that score, so the branch runs
// in the shipping code rather than a copy of its logic.
test("an unreadable item leaves the range describing only the scored items", { skip: !process.env.OFLOW_LAYA_TRIAGE_E2E }, async () => {
  const { summariseBoardText } = await import("../dist/laya-scrum.js");
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "oflow-guard-batch-"));
  try {
    // A stand-in engine: one entry has no verificationShare at all.
    const python = join(dir, "py");
    writeFileSync(python, [
      "#!/usr/bin/env python3",
      "import json, sys",
      "json.loads(sys.stdin.read())",
      "print(json.dumps([",
      "  {'answers': {'verificationShare': {'type': 'score', 'score': 2.0}}},",
      "  {'answers': {}},",
      "  {'answers': {'verificationShare': {'type': 'score', 'score': 0.8}}},",
      "]))",
    ].join("\n"));
    chmodSync(python, 0o755);
    const summary = await summariseBoardText(
      // The unreadable text is deliberately the LONGEST item on the board, so
      // if it leaked into the range the assertion below would fail.
      [
        "Verify the rollback path",
        "This particular item is deliberately long and the engine could not read it at all",
        "Bump deps",
      ],
      { python, timeoutMs: 30000 },
    );
    assert.ok(summary, "summary expected");
    assert.equal(summary.items, 2, "only the scored items are counted");
    // The unreadable item is 16 words. If its length leaked into the range,
    // this would read [4, 16, 2] and the range would be 2-16, not 2-4.
    assert.deepEqual(summary.wordCounts, [4, 2]);
    assert.match(describeBoard(summary), /ranges 2-4 words/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The band edges and the 0.2 margin were fitted on short hand-written items.
// On the input `assess --triage` actually sends -- title plus a full
// description including acceptance criteria -- two of four realistic stories
// come out wrong: a 2.36 verification story is silenced by the margin, and a
// 1.82 construction story is described as verification work.
//
// This pins those measurements. It is a characterization test, not a
// correctness claim: if the edges are ever re-fitted on real input, update it
// with the new numbers rather than deleting the expectation.
test("the band edges are uncalibrated on realistic story-shaped input", () => {
  const at = (score) => readVerificationShare({ verificationShare: { type: "score", score, probabilities: {} } });

  // 0.06 from the 2.3 edge: silenced, though it is the clearest verification
  // item measured.
  const clearVerification = at(2.36);
  assert.equal(clearVerification.band, "verification");
  assert.equal(clearVerification.uncertain, true);
  assert.equal(describeVerificationShare(clearVerification), null);

  // Clear of any edge, yet constructive: described as verification work.
  const construction = at(1.82);
  assert.equal(construction.band, "mixed");
  assert.equal(construction.uncertain, false);
  assert.match(describeVerificationShare(construction), /verification/);

  // The two that come out right, so the ratio is visible: two of four.
  assert.equal(describeVerificationShare(at(2.09)), "partly verification and evidence work");
  assert.equal(describeVerificationShare(at(1.67)), null);
});

// The board path is withdrawn on the same evidence as assess --triage: the
// 31% false-alarm figure was measured on SHORT titles, and on story-shaped
// input the same question flagged 13 of 13 items including 8 of 8
// construction ones. summariseBoard stays exported and tested because the
// counting is sound; only the scoring is unfit.
test("the board path is withheld on story-shaped input unless overridden", { skip: !process.env.OFLOW_LAYA_SCRUM_E2E }, async () => {
  const { summariseBoardText } = await import("../dist/laya-scrum.js");
  const board = ["Add a cursor to the work list", "Verify the rollback path"];
  assert.equal(await summariseBoardText(board, { python: "/no/such/python" }), null);
  assert.equal(await summariseBoardText([]), null);
});

// The measurement behind the withdrawal, as a characterization test. The
// between-class gap collapses from 0.52 on short titles to 0.17 on
// story-shaped input, which is why a threshold cannot separate the classes.
test("the board false-alarm rate depends entirely on the input", () => {
  const shortGap = 1.91 - 1.39;   // verification mean - construction mean
  const storyGap = 1.99 - 1.82;
  assert.ok(shortGap > 0.5, "short titles separate: " + shortGap.toFixed(2));
  assert.ok(storyGap < 0.2, "story-shaped collapses: " + storyGap.toFixed(2));
  // On story-shaped input every construction item scored above the edge.
  assert.ok(1.66 >= 1.5, "lowest construction score on story input clears the edge");
});

// Rewording was tried before recommending recalibration, and it does not work.
// On story-shaped input the shipped wording has a between-class gap of 0.171;
// naming the acceptance-criteria vocabulary drops it to 0.075, and framing it
// as reviewer cost to 0.080. Both alternatives are worse. The within-class
// spread is small precisely because the question compresses everything into a
// narrow band whatever you ask, so there is little variance for a better
// wording to exploit.
test("rewording the question does not separate the classes on story input", () => {
  const measured = {
    shipped: { gap: 0.171, spread: 0.138 },
    acceptanceVocabulary: { gap: 0.075, spread: 0.096 },
    reviewerCost: { gap: 0.080, spread: 0.067 },
  };
  // Neither alternative is an improvement on the shipped wording.
  assert.ok(measured.acceptanceVocabulary.gap < measured.shipped.gap);
  assert.ok(measured.reviewerCost.gap < measured.shipped.gap);
  // And the acceptance-criteria framing, the most promising idea, overlaps
  // outright -- so it could not carry a threshold at all.
  assert.ok(measured.acceptanceVocabulary.gap < measured.acceptanceVocabulary.spread);
  // Whatever ships must clear its own spread, which on short titles it did and
  // on story-shaped input it did not.
  assert.ok(measured.shipped.gap > measured.shipped.spread);
});
