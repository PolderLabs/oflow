/**
 * Optional classification hints backed by Laya, a local non-autoregressive
 * decision engine.
 *
 * This module is deliberately advisory. It never blocks, never rewrites a
 * plan, and never fails a command: if Laya is missing, slow, or wrong, the
 * caller gets `null` and proceeds exactly as before. oflow itself keeps no
 * dependency on it -- Laya is an external Python program discovered at
 * runtime, so oflow stays dependency-light and installable from a bare
 * `npm install`.
 *
 * The interface is a plain text-in / verdict-out shape with no oflow types, so
 * the same module can back planning in other tools.
 *
 * ## What the engine is actually good for
 *
 * Every question below was calibrated on this host before being kept, and the
 * calibration is what decides what ships. Full results in
 * `docs/LAYA-TRIAGE.md`.
 *
 * **Kept — `verificationShare`.** Asks how much of a work item is checking
 * existing behaviour rather than writing new behaviour. On a ten-item probe
 * it separated construction from evidence-gathering correctly 7 of 8 times on
 * cases with a clear expected answer, and repeated runs are bit-identical.
 * That is a genuine review-effort signal: an item heavy in verification costs
 * a reviewer far more attention than its size suggests.
 *
 * **Dropped — a difficulty band.** The engine's stock difficulty score
 * correlates 0.82 with input word count, and on equal-word-count pairs of one
 * genuinely trivial item against one genuinely hard item it separated them by
 * +0.02, -0.08, and +0.75 -- that is, usually not at all. Surfacing a
 * `trivial`/`easy`/`moderate`/`hard` label computed from that would dress a
 * length meter up as a difficulty estimate, and a caller would reasonably
 * trust it. The raw `score` is still reported so the model's output stays
 * inspectable, but nothing may branch on it.
 *
 * **Dropped — `executorFit` and `specificationGap`.** Both were implemented,
 * calibrated, and removed. `executorFit` called every verify/audit/confirm
 * task agent-suitable, including ones that plainly need human judgement
 * (5 of 10 correct). `specificationGap` ranged 0.07-0.54 with no ordering that
 * matched obvious specificity -- "rename the button label" scored 0.09, the
 * *most* specific item in the set. Neither is exposed, because a hint that is
 * wrong in this way is worse than no hint.
 *
 * ## Why the score is not trusted
 *
 * The published checkpoint ships invalid temperatures, and its own
 * RuntimeWarning states the affected confidences are uncalibrated.
 * Forwarding that number would mean passing along a figure the engine
 * disowned, so `confidence` is reported as 0 and callers must not gate on it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface TriageSignal {
  /**
   * Raw score for the `verificationShare` question, on that question's own
   * 0..3 scale: 0 is all new construction, 3 is mostly verification and
   * evidence gathering. Inspectable only -- see the module comment for the
   * measurements on the engine's other outputs.
   */
  score: number;
  /**
   * Laya's own confidence. Zero for the currently published checkpoint, whose
   * RuntimeWarning states the affected entries are uncalibrated.
   */
  confidence: number;
  /**
   * Laya's top domain guess: code, writing, math_or_logic, and so on. A weak
   * hint, never a routing decision.
   */
  domain: string;
  /** True when the score sits within 0.2 of a band edge, making the label weak. */
  uncertain: boolean;
}

export interface TriageOptions {
  /** Milliseconds before the probe is abandoned. */
  timeoutMs?: number;
  /** Override the Laya executable, for tests and unusual installs. */
  executable?: string;
}

/**
 * A real Laya call on this host takes ~3.7s, dominated by engine start-up
 * rather than by the input. The floor is therefore well above a normal network
 * round trip, and 4s left no headroom at all -- a slightly slower machine
 * would have turned every probe into a silent null, which reads as "Laya is
 * not installed" and makes the feature look dead.
 */
const DEFAULT_TIMEOUT_MS = 20000;

interface LayaPayload {
  answers?: {
    difficulty?: { score?: unknown; confidence?: unknown };
    domain?: { probabilities?: Record<string, unknown> };
  };
}

function topDomain(probabilities: Record<string, unknown> | undefined): string {
  if (!probabilities || typeof probabilities !== "object") return "unknown";
  let best = "";
  let bestValue = 0;
  for (const [name, value] of Object.entries(probabilities)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    if (value > bestValue) {
      best = name;
      bestValue = value;
    }
  }
  return best || "unknown";
}

function parsePayload(raw: string): TriageSignal | null {
  let payload: LayaPayload;
  try {
    payload = JSON.parse(raw) as LayaPayload;
  } catch {
    return null;
  }
  const score = payload.answers?.difficulty?.score;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;

  return {
    score,
    confidence: 0,
    domain: topDomain(payload.answers?.domain?.probabilities),
    uncertain: Math.abs(score * 2 - Math.round(score * 2)) < 0.4,
  };
}

/**
 * Ask Laya to classify `text`. Returns `null` whenever the signal is
 * unavailable for any reason -- Laya not installed, not on PATH, too slow,
 * unparseable, or uncalibrated. A `null` is always safe to ignore.
 */
export async function triageText(
  text: string,
  options: TriageOptions = {},
): Promise<TriageSignal | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const executable = options.executable ?? process.env.OFLOW_LAYA_BIN ?? "laya";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const { stdout } = await run(
      executable,
      // --device cpu: on this host the default device path aborts inside a
      // broken triton build, and a classification hint is not worth a GPU.
      ["--predict", "--device", "cpu", "--json", trimmed],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );
    return parsePayload(stdout);
  } catch {
    // Missing binary, timeout, non-zero exit, or a crash inside the engine.
    // All of these mean "no signal", never a failure of the calling command.
    return null;
  }
}

/**
 * Render a classification hint as one short advisory line. Returns `null`
 * without a signal, or when the domain is unknown and so says nothing.
 */
export function describeTriage(signal: TriageSignal | null): string | null {
  if (!signal || signal.domain === "unknown") return null;
  return "looks like a " + signal.domain + " task";
}
