import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { OflowError } from "./errors.js";
import { readJson, writeJson } from "./fs.js";
import { runGit } from "./git.js";
import type { VerificationCheckDefinition, VerificationConfig, VerificationRun, VerificationRunCheck, VerificationRunStore } from "./types.js";

const execFile = promisify(execFileCallback);
export const LOCAL_VERIFICATION_RELATIVE_PATH = ".oflow/cache/local-verification.json";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 32_768;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 262_144;

export interface LocalVerificationStatus {
  state: "unconfigured" | "configured" | "missing" | "stale" | "passed" | "failed" | "skipped";
  policy: "required" | "optional" | "unconfigured";
  passed: boolean;
  blocking: boolean;
  targetDigest: string;
  lastRun: VerificationRun | null;
  reason: string;
  nextCommand: string | null;
}

function ignoredStatePath(path: string): boolean {
  return path.startsWith(".oflow/cache/") || path.startsWith(".oflow/state/");
}

export async function currentTreeDigest(root: string): Promise<string> {
  const [index, status, untracked] = await Promise.all([
    runGit(["ls-files", "-s"], root),
    runGit(["status", "--porcelain=v1", "--untracked-files=no"], root),
    runGit(["ls-files", "--others", "--exclude-standard"], root),
  ]);
  let diff = "";
  try {
    diff = await runGit(["diff", "--binary", "HEAD"], root);
  } catch {
    try { diff = await runGit(["diff", "--binary", "--cached"], root); } catch { diff = ""; }
  }
  const filteredStatus = status.split("\n").filter((line) => {
    const path = line.length > 3 ? line.slice(3).trim().replace(/^"|"$/g, "") : "";
    return !ignoredStatePath(path);
  });
  const untrackedPaths = untracked.split("\n").filter((path) => path.length > 0 && !ignoredStatePath(path)).sort();
  const hash = createHash("sha256");
  hash.update(index).update("\n").update(diff).update("\n").update(filteredStatus.join("\n")).update("\n");
  for (const relativePath of untrackedPaths) hash.update(relativePath).update("\0").update(await readFile(join(root, relativePath)));
  return hash.digest("hex");
}

export async function loadLocalVerificationRun(root: string): Promise<VerificationRun | null> {
  const stored = await readJson<VerificationRunStore>(join(root, LOCAL_VERIFICATION_RELATIVE_PATH));
  return stored?.lastRun ?? null;
}

export async function getLocalVerificationStatus(root: string, verification: VerificationConfig | undefined): Promise<LocalVerificationStatus> {
  const targetDigest = await currentTreeDigest(root);
  if (!verification) return { state: "unconfigured", policy: "unconfigured", passed: false, blocking: false, targetDigest, lastRun: null, reason: "Legacy project has no repository verification contract.", nextCommand: "Run oflow install to add workflow.verification to .oflow/config.json." };
  if (verification.checks.length === 0) return { state: "configured", policy: verification.policy, passed: false, blocking: verification.policy === "required", targetDigest, lastRun: null, reason: "Repository verification is configured but has no checks.", nextCommand: "Add at least one argv check to workflow.verification.checks." };
  const lastRun = await loadLocalVerificationRun(root);
  if (!lastRun) return { state: "missing", policy: verification.policy, passed: false, blocking: verification.policy === "required", targetDigest, lastRun, reason: "No repository verification run is recorded.", nextCommand: "Run oflow verify-local." };
  if (lastRun.targetDigest !== targetDigest) return { state: "stale", policy: verification.policy, passed: false, blocking: verification.policy === "required", targetDigest, lastRun, reason: "The recorded verification run is stale for the current Git tree.", nextCommand: "Run oflow verify-local after the latest source change." };
  return { state: lastRun.status, policy: verification.policy, passed: lastRun.status === "passed", blocking: verification.policy === "required" && lastRun.status !== "passed", targetDigest, lastRun, reason: lastRun.status === "passed" ? "All repository verification checks passed." : "Repository verification did not pass.", nextCommand: lastRun.status === "passed" ? null : "Run oflow verify-local." };
}

export async function runLocalVerification(root: string, verification: VerificationConfig | undefined): Promise<VerificationRun> {
  const initialDigest = await currentTreeDigest(root);
  if (!verification || verification.checks.length === 0) return { status: "unconfigured", ranAt: new Date().toISOString(), targetDigest: initialDigest, perCheck: [] };
  const ids = new Set<string>();
  for (const check of verification.checks) {
    if (ids.has(check.id)) throw new OflowError("Verification check ids must be unique.", "INVALID_VERIFICATION_CHECK");
    ids.add(check.id);
  }
  const perCheck: VerificationRunCheck[] = [];
  for (const check of verification.checks) {
    validateCheck(check);
    const startedAt = Date.now();
    const outputBytes = check.outputBytes ?? DEFAULT_OUTPUT_BYTES;
    try {
      const result = await execFile(check.command[0], check.command.slice(1), { cwd: root, timeout: check.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: outputBytes, encoding: "utf8", windowsHide: true });
      const rawOutput = result.stdout + result.stderr;
      perCheck.push({ id: check.id, command: check.command, status: "passed", exitCode: 0, durationMs: Date.now() - startedAt, output: rawOutput.slice(-outputBytes), outputTruncated: rawOutput.length > outputBytes });
    } catch (error: unknown) {
      const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      const rawOutput = String(value.stdout ?? "") + String(value.stderr ?? "");
      perCheck.push({ id: check.id, command: check.command, status: "failed", exitCode: typeof value.code === "number" ? value.code : null, durationMs: Date.now() - startedAt, output: rawOutput.slice(-outputBytes), outputTruncated: rawOutput.length > outputBytes });
    }
  }
  const targetDigest = await currentTreeDigest(root);
  const result: VerificationRun = {
    status: targetDigest === initialDigest && perCheck.every((check) => check.status === "passed") ? "passed" : "failed",
    ranAt: new Date().toISOString(), targetDigest, perCheck,
  };
  await mkdir(join(root, ".oflow", "cache"), { recursive: true });
  await writeJson(join(root, LOCAL_VERIFICATION_RELATIVE_PATH), { lastRun: result });
  return result;
}

function validateCheck(check: VerificationCheckDefinition): void {
  if (!/^[a-z][a-z0-9._-]*$/i.test(check.id)) throw new OflowError("Invalid verification check id.", "INVALID_VERIFICATION_CHECK");
  if (check.command.length === 0 || check.command.some((argument) => argument.length === 0)) throw new OflowError("Verification check command must be a non-empty argv array.", "INVALID_VERIFICATION_CHECK");
  if (check.command.some((argument) => /[\r\n\0]/.test(argument))) throw new OflowError("Verification command arguments cannot contain control characters.", "INVALID_VERIFICATION_CHECK");
  if (check.command.some((argument) => /(?:^|[-_])(?:token|password|secret)(?:$|[-_=])/i.test(argument))) throw new OflowError("Verification commands cannot contain credential-like arguments.", "INVALID_VERIFICATION_CHECK");
  if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > MAX_TIMEOUT_MS)) throw new OflowError("Verification timeoutMs must be between 1 and " + MAX_TIMEOUT_MS + ".", "INVALID_VERIFICATION_CHECK");
  if (check.outputBytes !== undefined && (!Number.isInteger(check.outputBytes) || check.outputBytes < 1 || check.outputBytes > MAX_OUTPUT_BYTES)) throw new OflowError("Verification outputBytes must be between 1 and " + MAX_OUTPUT_BYTES + ".", "INVALID_VERIFICATION_CHECK");
}
