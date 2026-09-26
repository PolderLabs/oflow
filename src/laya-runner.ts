/**
 * A thin, portable wrapper around the Laya decision engine.
 *
 * Everything here is text-in / answers-out and free of any oflow type, so the
 * module can be lifted into another planning tool unchanged. The engine itself
 * is an external Python program discovered at runtime: there is no npm
 * dependency, which is what lets oflow stay installable from a bare install.
 *
 * Two call paths, and the difference matters:
 *
 * - {@link runDefaultQuestions} shells out to the `laya` CLI and reads its
 *   stock router questions. Simple, no Python API, but the questions are
 *   whatever upstream ships.
 * - {@link runCustomQuestions} uses the library API, which accepts a question
 *   set. That is what makes domain-specific questions -- "how much of this is
 *   verification rather than construction" -- possible at all.
 *
 * Both are advisory. Every failure mode returns `null` rather than throwing,
 * so a caller can never be broken by the engine being absent or unhealthy.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Run a program and write `input` to its stdin. `promisify(execFile)` has no
 * `input` option, so the custom-question path needs this to keep the question
 * set off both the command line and the filesystem.
 */
function runWithInput(
  command: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("laya probe timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error("laya exited " + String(code) + ": " + stderr.slice(0, 300)));
    });
    child.stdin.on("error", () => { /* the child may exit before reading */ });
    child.stdin.end(input);
  });
}

/** One question in the engine's schema. Variable references look like `name`. */
export interface LayaQuestion {
  /** A `score`, `choice`, or `noul` question. */
  type: "score" | "choice" | "noul";
  /** The question, naming variables in backticks. */
  instructions: string;
  /** Ordered levels for a `score`, or named options for a `choice`. */
  criteria?: string[] | Record<string, string | null>;
}

export type LayaQuestions = Record<string, LayaQuestion>;

export type LayaAnswer =
  | {
      type: "score";
      score: number;
      /** Highest-probability level, and the full distribution. */
      top: string;
      probabilities: Record<string, number>;
    }
  | { type: "choice"; top: string; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };

export type LayaAnswers = Record<string, LayaAnswer>;

/**
 * Which checkpoint to answer with.
 *
 * All three were measured on 40 labelled items -- 20 construction, 20
 * verification -- using the cost model oflow actually imposes, since
 * `assess --triage` prints one advisory line or nothing. A missed
 * verification item is invisible; a false alarm is a line a reader discounts.
 *
 * | checkpoint | missed | false alarms | precision | recall |
 * |---|---:|---:|---:|---:|
 * | english | 13 | 0 | 1.00 | 0.35 |
 * | **typed-decisions** | **5** | **1** | **0.94** | **0.75** |
 * | multilingual | 12 | 15 | 0.35 | 0.40 |
 *
 * `typed-decisions` is the default: it catches more than twice as much
 * verification work for one false alarm. `english` is the safest signal --
 * it never cries wolf -- but at 0.35 recall it says nothing about two thirds
 * of the verification work it exists to surface, which is useless. And
 * `multilingual`, which looked compelling on two individual items, is the
 * worst of the three on a real set.
 */
export type LayaCheckpoint = "english" | "multilingual" | "typed-decisions";

export interface RunnerOptions {
  /** Override the `laya` executable. Defaults to $OFLOW_LAYA_BIN, then PATH. */
  executable?: string;
  /** Which checkpoint to use. Defaults to `english`. */
  checkpoint?: LayaCheckpoint;
  /** Override the Python interpreter used for the custom-question path. */
  python?: string;
  /** Milliseconds before the probe is abandoned. */
  timeoutMs?: number;
  /**
   * The checkpoint observed on laya 0.3.10 ships invalid temperatures, and its
   * own RuntimeWarning says the affected confidences are uncalibrated. Callers
   * must not gate on a confidence figure. This is version-dependent -- if a
   * later release stops emitting the warning, the figures become worth
   * reporting, so re-check on upgrade rather than assuming either way.
   */
  uncalibratedCheckpoint?: boolean;
}

/**
 * A real call costs about 3.7s on a CPU-only host, dominated by engine
 * start-up rather than by the input. 4s left no headroom at all: a slightly
 * slower machine turned every successful probe into a silent null, which reads
 * as "Laya is not installed".
 */
const DEFAULT_TIMEOUT_MS = 20000;

/** The checkpoint with the best measured recall at usable precision. */
export const DEFAULT_CHECKPOINT: LayaCheckpoint = "typed-decisions";

function toProbabilities(value: unknown): Record<string, number> {
  // One Object.entries pass with a typeof check per field: strong enough for
  // the numbers this reads, without a guard that only re-proves "an object".
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

function topOf(probabilities: Record<string, number>): string {
  let best = "";
  let bestValue = 0;
  for (const [name, value] of Object.entries(probabilities)) {
    if (value > bestValue) {
      best = name;
      bestValue = value;
    }
  }
  return best || "unknown";
}

/** Normalise one raw engine answer, or `null` if the shape is unusable. */
function normalizeAnswer(raw: unknown): LayaAnswer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const answer = raw as Record<string, unknown>;
  const type = answer.type;
  if (type === "score") {
    const score = answer.score;
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    const probabilities = toProbabilities(answer.probabilities);
    return { type: "score", score, top: topOf(probabilities), probabilities };
  }
  if (type === "choice") {
    const probabilities = toProbabilities(answer.probabilities);
    return { type: "choice", top: topOf(probabilities), probabilities };
  }
  if (type === "noul") {
    const noul = answer.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul)) return null;
    return { type: "noul", noul };
  }
  return null;
}

/**
 * Run the engine's stock router questions over `text` through the CLI.
 *
 * This is the path with no Python API dependency, so it is the one to prefer
 * when the engine is only available as an executable.
 */
export async function runDefaultQuestions(
  text: string,
  options: RunnerOptions = {},
): Promise<LayaAnswers | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const executable = options.executable ?? process.env.OFLOW_LAYA_BIN ?? "laya";
  try {
    const { stdout } = await run(
      executable,
      // --device cpu: on a host without a working CUDA toolchain the default
      // device path aborts inside triton, and a hint is not worth a GPU.
      ["--predict", "--device", "cpu", "--json", trimmed],
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return parseAnswers(stdout);
  } catch {
    return null;
  }
}

/**
 * Run a custom question set over `text` through the library API.
 *
 * This is the path that makes domain-specific questions possible. The engine
 * is passed the question set as JSON on stdin, so no temporary file is needed
 * and the process stays free of any local path that could leak.
 */
export async function runCustomQuestions(
  text: string,
  questions: LayaQuestions,
  options: RunnerOptions = {},
): Promise<LayaAnswers | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (Object.keys(questions).length === 0) return null;

  const python =
    options.python ??
    process.env.OFLOW_LAYA_PYTHON ??
    (process.platform === "win32" ? "python" : "python3");

  // The script is passed via stdin so the question set and the text never
  // reach a shell, an argv list, or the filesystem.
  const script = `
import json, sys
import laya
payload = json.loads(sys.stdin.read())
subfolder = payload.get("checkpoint")
agent = laya.Agent(
    model_id_or_path="convaiinnovations/laya",
    subfolder=None if subfolder == "english" else subfolder,
    device="cpu",
)
result = agent.predict({"request": payload["text"]}, payload["questions"])
sys.stdout.write(json.dumps(result.get("answers", {})))
`;
  try {
    const stdout = await runWithInput(
      python,
      ["-c", script],
      JSON.stringify({
        text: trimmed,
        questions,
        checkpoint: options.checkpoint ?? DEFAULT_CHECKPOINT,
      }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return parseAnswers(stdout);
  } catch {
    return null;
  }
}

/**
 * Answer one question set over many items in a single engine call.
 *
 * Measured against one call per item on a ten-item board: 1.75x faster, and
 * the scores are bit-identical, so batching is a pure cost win rather than a
 * trade of accuracy for speed. Returns per-item answers in input order, or
 * `null` if the engine is unavailable or the shape is unusable. An empty input
 * is never sent to the engine.
 */
export async function runCustomQuestionsBatch(
  texts: readonly string[],
  questions: LayaQuestions,
  options: RunnerOptions = {},
): Promise<LayaAnswers[] | null> {
  const items = texts.map((text) => text.trim()).filter((text) => text !== "");
  if (items.length === 0) return null;
  if (Object.keys(questions).length === 0) return null;

  const checkpoint = options.checkpoint ?? "english";
  const python =
    options.python ??
    process.env.OFLOW_LAYA_PYTHON ??
    (process.platform === "win32" ? "python" : "python3");

  // Same stdin discipline as the single-item path: neither the question set nor
  // the texts reach a shell, an argv list, or the filesystem.
  const script = `
import json, sys
import laya
payload = json.loads(sys.stdin.read())
subfolder = payload.get("checkpoint")
agent = laya.Agent(
    model_id_or_path="convaiinnovations/laya",
    subfolder=None if subfolder == "english" else subfolder,
    device="cpu",
)
states = [{"request": text} for text in payload["texts"]]
results = agent.predict_batch(states, payload["questions"])
sys.stdout.write(json.dumps([r.get("answers", {}) for r in results]))
`;
  try {
    const stdout = await runWithInput(
      python,
      ["-c", script],
      JSON.stringify({ texts: items, questions, checkpoint }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout) as unknown;
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const out: LayaAnswers[] = [];
    for (const entry of parsed) {
      out.push(parseAnswers(JSON.stringify(entry)) ?? {});
    }
    return out;
  } catch {
    return null;
  }
}

/** Parse an engine response into normalized answers, dropping unusable ones. */
export function parseAnswers(raw: string): LayaAnswers | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  // The CLI nests under `answers`; the library returns the map directly.
  const envelope = payload as Record<string, unknown>;
  const nested = envelope.answers;
  const source =
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : envelope;
  const out: LayaAnswers = {};
  for (const [key, value] of Object.entries(source)) {
    const answer = normalizeAnswer(value);
    if (answer !== null) out[key] = answer;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Convenience: the highest-probability level of a named question. */
export function topChoice(answers: LayaAnswers | null, key: string): string | null {
  const answer = answers?.[key];
  if (answer === undefined || answer.type === "noul") return null;
  return answer.top;
}
