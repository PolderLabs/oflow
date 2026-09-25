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
 * The interface is a plain text-in / verdict-out shape with no GitLab types,
 * so the same module can back planning in other tools.
 *
 * ## What the engine is actually good for
 *
 * Measured on this host against a ten-item probe, Laya's difficulty score
 * correlates 0.82 with input word count. On equal-word-count pairs of one
 * genuinely trivial item against one genuinely hard item it separated them by
 * +0.02, -0.08, and +0.75 -- that is, usually not at all. Its domain guess is
 * better but still imperfect: it correctly separated both non-code probe
 * items, and mislabelled several of the code ones.
 *
 * So there is deliberately no difficulty band here. Surfacing one would dress
 * a length meter up as a difficulty estimate, and a caller would reasonably
 * trust it. The raw score is still reported so the model's output stays
 * inspectable, but nothing in oflow may branch on it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface TriageSignal {
  /**
   * Laya's raw difficulty score, typically 0..3. Inspectable only -- see the
   * module comment for the measurements showing it tracks input length.
   */
  score: number;
  /**
   * Laya's own confidence. Zero for the currently published checkpoint, whose
   * RuntimeWarning states the affected entries are uncalibrated. Reporting a
   * number the engine disowned would be worse than reporting none.
   */
  confidence: number;
  /**
   * Laya's top domain guess: code, writing, math_or_logic, and so on. A weak
   * hint, never a routing decision.
   */
  domain: string;
}

export interface TriageOptions {
  /** Milliseconds before the probe is abandoned. */
  timeoutMs?: number;
  /** Override the Laya executable, for tests and unusual installs. */
  executable?: string;
}

/**
 * A real Laya call on this host takes ~3.7s, dominated by engine start-up
 * rather than by the input. The floor is therefore well above a normal
 * network round trip, and 4s left no headroom at all -- a slightly slower
 * machine would have turned every probe into a silent null, which reads as
 * "Laya is not installed" and makes the feature look dead.
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
