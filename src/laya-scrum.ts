/**
 * Scrum-planning question sets for the Laya engine.
 *
 * Only questions that survived calibration are exported. The set lives apart
 * from the engine wrapper so another planning tool can reuse the same
 * questions with a different runner, and so the calibration record can be
 * read next to the questions it justifies.
 *
 * ## Calibration summary (this host, ten-item probe)
 *
 * | Question | Verdict | Evidence |
 * |---|---|---|
 * | `verificationShare` | **kept** | 7/10 on a hand-labelled probe; 6/6 matched-length pairs, all positive; correlation with input length +0.022; repeated runs bit-identical |
 * | `executorFit` | dropped | 5/10; called every verify/audit/confirm task agent-suitable, including those needing human judgement |
 * | `specificationGap` | dropped | 0.07-0.54 with no ordering matching obvious specificity; "rename the button label" scored 0.09, the most specific item in the set |
 * | difficulty band | dropped | 0.82 correlation with input word count; equal-length trivial-vs-hard pairs separated by +0.02, -0.08, +0.75 |
 *
 * A hint that is wrong in these ways is worse than no hint, so only the one
 * that separated its cases is offered.
 *
 * What the kept signal is *not*: it measures how much evidence work an item
 * implies, not how good the item is, and nothing at all about story quality.
 */
import { runCustomQuestionsBatch, type LayaQuestion, type LayaQuestions, type RunnerOptions } from "./laya-runner.js";

/**
 * How much of a work item is checking existing behaviour and evidence rather
 * than writing new behaviour.
 *
 * This is a review-effort signal, not a size estimate: an item that is mostly
 * verification costs a reviewer far more attention than its length suggests,
 * which is exactly what sprint planning tends to get wrong.
 *
 * ## Known weakness, measured not assumed
 *
 * On realistic sprint-board titles the ordering survives (mean separation
 * +1.238) but the bands do not: construction reached 1.35 while verification
 * started at 1.16, so the two classes overlap. The same ten items written as
 * full sentences separate cleanly, 1.05 against 1.20.
 *
 * ## Where the residual failures actually are
 *
 * Two items are mis-banded at *both* lengths: "Check pipeline gating" (1.16
 * title, 1.20 sentence) and "Review the apply ordering" (1.47 / 1.30). Length is
 * therefore not the variable -- neither "gating" nor "ordering" reads as
 * "checking" to the engine, and both sit at the edge of what the question
 * resolves. What length does affect is separability: no error-free threshold
 * exists on short titles, while the sentence form separates cleanly.
 *
 * The uncertainty margin covers one of the two, and the honest figure is
 * therefore better than raw banding suggests:
 *
 * | item | score | distance to the 1.5 edge | disclaimed? |
 * |---|---:|---:|---|
 * | Review the apply ordering | 1.47 | 0.03 | **yes** |
 * | Check pipeline gating | 1.16 | 0.34 | **no** |
 *
 * So **one** verification item in ten is both mis-banded and presented without
 * a caveat, not two. The one that slips through is the worse of the pair, and
 * that is the failure mode to state: a score well clear of a band edge is not
 * evidence of correctness.
 *
 * A caller must still never read a construction verdict as proof that an item
 * contains no verification work. The hint is informative in the direction it is
 * reliable -- it flags verification-heavy items, and silence says nothing.
 */
export const VERIFICATION_SHARE: LayaQuestion = {
  type: "score",
  instructions:
    "For the work item `request`, how much of it is checking existing behaviour " +
    "and evidence (reading, verifying, confirming) rather than writing new behaviour?",
  criteria: [
    "0: all new construction",
    "1: mostly construction with a little verification",
    "2: roughly half and half",
    "3: mostly verification and evidence gathering",
  ],
};

/** The calibrated question set. */
export const SCRUM_QUESTIONS: LayaQuestions = {
  verificationShare: VERIFICATION_SHARE,
};

export type VerificationShareBand = "construction" | "mixed" | "verification";

export interface VerificationShare {
  /** Raw 0..3 score, exactly as the engine returned it. */
  score: number;
  band: VerificationShareBand;
  /**
   * True when the score sits within 0.2 of a band edge, so the band label
   * should not be acted on. Callers should surface the uncertainty rather
   * than round it away.
   */
  uncertain: boolean;
}

/** Band edges for the 0..3 scale, chosen to sit between the calibrated levels. */
const CONSTRUCTION_MAX = 1.5;
const MIXED_MAX = 2.3;

function toBand(score: number): VerificationShareBand {
  if (score < CONSTRUCTION_MAX) return "construction";
  if (score < MIXED_MAX) return "mixed";
  return "verification";
}

function nearEdge(score: number): boolean {
  return (
    Math.abs(score - CONSTRUCTION_MAX) < 0.2 ||
    Math.abs(score - MIXED_MAX) < 0.2
  );
}

/**
 * Read a `verificationShare` answer into a band.
 *
 * Returns `null` when the engine was unavailable or answered something else,
 * so a caller can treat "no signal" and "weak signal" as the same thing and
 * say nothing at all.
 */
export function readVerificationShare(
  answers: { verificationShare?: unknown } | null,
): VerificationShare | null {
  const raw = answers?.verificationShare;
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { type?: unknown }).type !== "score"
  ) {
    return null;
  }
  const score = (raw as { score?: unknown }).score;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return { score, band: toBand(score), uncertain: nearEdge(score) };
}

/**
 * Render a verification share as one advisory line, or `null` when there is
 * nothing worth saying. Callers should treat the result as a prompt for a
 * human to confirm, never as a decision.
 */
export function describeVerificationShare(
  value: VerificationShare | null,
): string | null {
  if (!value || value.uncertain) return null;
  if (value.band === "construction") return null;
  return value.band === "verification"
    ? "mostly verification and evidence work"
    : "partly verification and evidence work";
}

export type SummaryOptions = RunnerOptions;

export interface BoardSummary {
  /** Items examined. */
  items: number;
  /** Items scoring at or above the construction/verification boundary. */
  flagged: number;
  /** Mean score, or null when there was nothing to score. */
  mean: number | null;
  /**
   * Items that the measurement flags on a board that is in fact entirely
   * construction. Measured at 5 of 16 for the default checkpoint, so a flagged
   * count is a direction, not a measurement.
   */
  knownFalsePositiveFloor: string;
}

/**
 * Score a board's items and summarise them.
 *
 * Uses the batch path: measured at 1.75x faster than one call per item, with
 * bit-identical scores, so the difference is cost rather than accuracy. Falls
 * back to `null` whenever the engine is unavailable, which a caller must treat
 * as "no reading", never as "nothing is verification work".
 */
export async function summariseBoardText(
  texts: readonly string[],
  options: SummaryOptions = {},
): Promise<BoardSummary | null> {
  const answers = await runCustomQuestionsBatch(texts, SCRUM_QUESTIONS, options);
  if (answers === null) return null;
  const scores: number[] = [];
  for (const entry of answers) {
    const value = readVerificationShare(entry);
    // An unreadable item is left out rather than scored as zero, which would
    // read as "definitely construction" when it means "we do not know".
    if (value !== null) scores.push(value.score);
  }
  if (scores.length === 0) return null;
  return summariseBoard(scores);
}

/**
 * Summarise a board from already-scored items.
 *
 * A board figure is only useful comparatively -- this board against last
 * sprint's -- because the flagged count carries a measured false-positive
 * floor even when no item is genuinely verification work. The floor is
 * reported alongside the number so a reader cannot quote the count alone.
 */
export function summariseBoard(scores: number[]): BoardSummary {
  const items = scores.length;
  if (items === 0) {
    return { items: 0, flagged: 0, mean: null, knownFalsePositiveFloor: "no items" };
  }
  const flagged = scores.filter((score) => score >= CONSTRUCTION_MAX).length;
  const mean = scores.reduce((total, score) => total + score, 0) / items;
  return {
    items,
    flagged,
    mean,
    knownFalsePositiveFloor: "about 5 in 16 on a board with no verification work",
  };
}

/**
 * Render a board summary as one advisory line, or null when there is nothing
 * worth saying. Comparative by design: the number is only meaningful next to
 * another board measured the same way.
 */
export function describeBoard(summary: BoardSummary): string | null {
  if (summary.items === 0) return null;
  const share = Math.round((summary.flagged / summary.items) * 100);
  return `${summary.flagged} of ${summary.items} items read as verification-heavy ` +
    `(${share}%); treat that as a direction, not a count -- ` +
    `${summary.knownFalsePositiveFloor} scores the same way.`;
}
