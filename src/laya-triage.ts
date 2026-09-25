/**
 * Optional difficulty triage backed by Laya, a local non-autoregressive
 * decision engine.
 *
 * This module is deliberately advisory. It never blocks, never rewrites a
 * plan, and never fails a command: if Laya is missing, slow, or wrong, the
 * caller gets `null` and proceeds exactly as before. oflow itself keeps no
 * dependency on it -- Laya is an external Python program discovered at
 * runtime, so oflow stays dependency-light and installable from a bare
 * `npm install`.
 *
 * The triage interface is a plain text-in / verdict-out shape with no
 * GitLab types, so the same module can back planning in other tools.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Laya's own difficulty legend. The raw score is a continuous value; these
 * buckets are what Laya's legend documents, and are the only part worth
 * surfacing to a human.
 */
export type DifficultyBand = "trivial" | "easy" | "moderate" | "hard";

export interface TriageSignal {
  /** Raw score from Laya, typically 0..3. */
  score: number;
  /**
   * Laya's own confidence. Zero for the currently published checkpoint, whose
   * RuntimeWarning states the affected entries are uncalibrated; see
   * `parsePayload`.
   */
  confidence: number;
  band: DifficultyBand;
  /** Laya's domain guess: code, writing, math_or_logic, and so on. */
  domain: string;
  /**
   * True when the score sits within 0.2 of a band edge, meaning the band label
   * itself is not a meaningful distinction.
   */
  uncertain: boolean;
}

export interface TriageOptions {
  /** Milliseconds before the probe is abandoned. Keep this short. */
  timeoutMs?: number;
  /** Override the Laya executable, for tests and unusual installs. */
  executable?: string;
}

const DEFAULT_TIMEOUT_MS = 4000;

interface LayaPayload {
  answers?: {
    difficulty?: { score?: unknown; confidence?: unknown };
    domain?: { probabilities?: Record<string, unknown> };
  };
}

function toBand(score: number): DifficultyBand {
  // Band edges follow Laya's legend, whose anchors are the integers 0..3.
  if (score < 0.5) return "trivial";
  if (score < 1.5) return "easy";
  if (score < 2.5) return "moderate";
  return "hard";
}

function isUncertain(score: number): boolean {
  return Math.abs(score * 2 - Math.round(score * 2)) < 0.4;
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
  const difficulty = payload.answers?.difficulty;
  const score = difficulty?.score;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;

  return {
    score,
    // The published checkpoint ships invalid temperatures and its own
    // RuntimeWarning says the affected confidences are uncalibrated. Passing
    // along a number the engine disowned would be worse than reporting none,
    // so the score stands alone and confidence stays 0.
    confidence: 0,
    band: toBand(score),
    domain: topDomain(payload.answers?.domain?.probabilities),
    uncertain: isUncertain(score),
  };
}

/**
 * Ask Laya to triage `text`. Returns `null` whenever the signal is
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
      // broken triton build, and a triage hint is not worth a GPU.
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
 * Render a triage signal as a short human-readable advisory. Returns `null`
 * when there is no signal, or when the score sits too close to a band edge for
 * the band label to mean anything.
 */
export function describeTriage(signal: TriageSignal | null): string | null {
  if (!signal || signal.uncertain) return null;
  return "estimated " + signal.band + " (" + signal.score.toFixed(2) + ")";
}
