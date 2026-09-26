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
 * | `verificationShare` | **kept** | 7/8 correct on cases with a clear expected answer; repeated runs bit-identical |
 * | `executorFit` | dropped | 5/10; called every verify/audit/confirm task agent-suitable, including those needing human judgement |
 * | `specificationGap` | dropped | 0.07-0.54 with no ordering matching obvious specificity; "rename the button label" scored 0.09, the most specific item in the set |
 * | difficulty band | dropped | 0.82 correlation with input word count; equal-length trivial-vs-hard pairs separated by +0.02, -0.08, +0.75 |
 *
 * A hint that is wrong in these ways is worse than no hint, so only the one
 * that separated its cases is offered.
 */
import type { LayaQuestion, LayaQuestions } from "./laya-runner.js";

/**
 * How much of a work item is checking existing behaviour and evidence rather
 * than writing new behaviour.
 *
 * This is a review-effort signal, not a size estimate: an item that is mostly
 * verification costs a reviewer far more attention than its length suggests,
 * which is exactly what sprint planning tends to get wrong.
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
