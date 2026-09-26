import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { OflowError } from "./errors.js";

export type DashboardAction = "refresh" | "context" | "assess" | "handoff" | "verify-local";
export interface DashboardJob {
  id: string;
  action: DashboardAction;
  story: number | null;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  result: unknown;
  error: string | null;
}
export interface ActionProcess {
  completed: Promise<{ code: number | null; stdout: string; overflow?: boolean }>;
  terminate(): void;
}
export type ActionRunner = (args: string[], root: string) => ActionProcess;
const MAX_OUTPUT = 262_144;
const MAX_JOBS = 30;
const ACTIONS = new Set(["refresh", "context", "assess", "handoff", "verify-local"]);

export function parseDashboardAction(body: unknown): { action: DashboardAction; story: number | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidAction();
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "action" && key !== "story") ||
      typeof value.action !== "string" || !ACTIONS.has(value.action)) throw invalidAction();
  const needsStory = ["context", "assess", "handoff"].includes(value.action);
  if (needsStory ? !Number.isSafeInteger(value.story) || Number(value.story) <= 0 : "story" in value) throw invalidAction();
  return { action: value.action as DashboardAction, story: needsStory ? value.story as number : null };
}
function invalidAction(): OflowError {
  return new OflowError("Choose refresh, context, assess, handoff, or verify-local; story actions require a positive integer story and no other fields.", "INVALID_DASHBOARD_ACTION");
}

/** Fixed argv only: browser input cannot select an executable, path, flag, or shell. */
export function dashboardActionArgs(action: DashboardAction, story: number | null): string[] {
  return action === "refresh" ? ["sync", "--refresh", "--json"]
    : story === null ? [action, "--json"] : [action, "--story", String(story), "--json"];
}

export function runDashboardCli(args: string[], root: string): ActionProcess {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.url)), ...args], {
    cwd: root, shell: false, detached: process.platform !== "win32", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  const decoder = new StringDecoder("utf8");
  let size = 0;
  let overflow = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const signal = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* The process may already have exited. */ }
  };
  const terminate = () => {
    signal("SIGTERM");
    if (!killTimer) {
      killTimer = setTimeout(() => signal("SIGKILL"), 1000);
      killTimer.unref();
    }
  };
  const completed = new Promise<{ code: number | null; stdout: string; overflow: boolean }>((resolve) => {
    const consume = (chunk: Buffer, capture: boolean) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { overflow = true; terminate(); return; }
      if (capture) stdout += decoder.write(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
    child.once("error", () => resolve({ code: null, stdout: "", overflow }));
    child.once("close", (code) => { resolve({ code, stdout: stdout + decoder.end(), overflow }); });
  });
  return { completed, terminate };
}

/** Deliberate field projection: subprocess output and new CLI fields are withheld by default. */
const RESULT_FIELDS = new Set([
  "generatedAt", "syncedAt", "branch", "project", "host", "path", "name", "story", "iid", "id", "title", "description", "issueType", "issue_type", "state", "status", "webUrl", "web_url", "labels", "assignees", "username", "milestone", "iteration", "startDate", "dueDate", "weight", "taskCompletion", "completed", "total", "parent", "criteria", "text", "checked", "evidence", "localReferences", "kind", "line", "reason", "warnings", "blockers", "nextActions", "mergeRequest", "mergeRequests", "mergeRequestPipelines", "pipelines", "pipeline", "draft", "sha", "ref", "local", "remote", "clean", "changedFiles", "recentCommits", "pipelinePolicy", "ciConfigPresent", "summary", "counts", "workItems", "planning", "delivery", "ranAt", "targetDigest", "perCheck", "exitCode", "durationMs", "outputTruncated",
]);
export function projectDashboardActionResult(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 9) return null;
  if (typeof value === "string") {
    let text = value.slice(0, 16000);
    for (const secret of secrets) if (secret.length >= 4) text = text.split(secret).join("[redacted]");
    return text.replace(/\bglpat-[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[redacted]")
      .replace(/([?&](?:access_token|private_token|token)=)[^&#\s]+/gi, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => projectDashboardActionResult(entry, secrets, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => RESULT_FIELDS.has(key)).map(([key, entry]) => [key, projectDashboardActionResult(entry, secrets, depth + 1)]));
  return value === null || typeof value === "boolean" || typeof value === "number" ? value : null;
}

/** Bounded, redacted local history; never stores raw subprocess output. */
export class DashboardActions {
  private jobs: DashboardJob[] = [];
  private active: { job: DashboardJob; process: ActionProcess } | null = null;
  private starting = false;
  private writes: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private root: string, private runner: ActionRunner = runDashboardCli, private timeoutMs = 600_000) {
    this.ready = this.restore();
  }
  private async cachePath(create = false): Promise<string> {
    let directory = this.root;
    for (const part of [".oflow", "cache"]) {
      directory = join(directory, part);
      if (create) await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe action cache directory.");
    }
    return join(directory, "dashboard-actions.json");
  }
  private async restore(): Promise<void> {
    try {
      const path = await this.cachePath();
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let stored: unknown;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 8_388_608) return;
        stored = JSON.parse(await file.readFile("utf8"));
      } finally { await file.close(); }
      if (!Array.isArray(stored)) return;
      for (const value of stored.slice(0, MAX_JOBS)) {
        if (!value || typeof value !== "object" || !/^[a-f0-9-]{36}$/.test(value.id) || !["running", "succeeded", "failed", "cancelled"].includes(value.status)) continue;
        try { parseDashboardAction(value.story === null ? { action: value.action } : { action: value.action, story: value.story }); } catch { continue; }
        if (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) continue;
        this.jobs.push({ id: value.id, action: value.action, story: value.story, status: value.status === "running" ? "failed" : value.status,
          startedAt: value.startedAt, finishedAt: typeof value.finishedAt === "string" && Number.isFinite(Date.parse(value.finishedAt)) ? value.finishedAt : new Date().toISOString(),
          result: projectDashboardActionResult(value.result, environmentSecrets()),
          error: value.status === "running" ? "Dashboard stopped before this action completed; it was not resumed." : value.error ? "See the recorded result or rerun the CLI command for details." : null });
      }
    } catch { /* Missing, invalid, or unsafe history is not read. */ }
  }
  private persist(): void {
    const snapshot = JSON.stringify(this.jobs);
    this.writes = this.writes.then(async () => {
      const path = await this.cachePath(true);
      const temporary = path + "." + randomUUID() + ".tmp";
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(snapshot); } finally { await file.close(); }
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
    }).catch(() => { /* Unsafe/unwritable local cache never blocks cancellation or exposes process output. */ });
  }
  async flush(): Promise<void> { await this.writes; }
  list(): DashboardJob[] { return structuredClone(this.jobs); }
  get(id: string): DashboardJob | null { return structuredClone(this.jobs.find((job) => job.id === id) ?? null); }
  async start(body: unknown): Promise<DashboardJob> {
    const { action, story } = parseDashboardAction(body);
    await this.ready;
    if (this.active || this.starting) throw new OflowError("Another dashboard action is still running.", "DASHBOARD_ACTION_BUSY");
    this.starting = true;
    try {
      if (action === "verify-local") {
        const config = await loadConfig(this.root);
        if (!config?.workflow?.verification?.checks.length) throw new OflowError("Configure repository verification checks before running verify-local.", "DASHBOARD_CHECKS_UNCONFIGURED");
      }
      const job: DashboardJob = { id: randomUUID(), action, story, status: "running", startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
      const child = this.runner(dashboardActionArgs(action, story), this.root);
      this.active = { job, process: child };
      this.jobs.unshift(job);
      this.jobs.length = Math.min(this.jobs.length, MAX_JOBS);
      this.persist();
      const timer = setTimeout(() => {
        if (job.status === "running") { job.error = "Action exceeded its time limit."; child.terminate(); }
      }, this.timeoutMs);
      timer.unref();
      void child.completed.then((output) => {
        if (job.status === "cancelled") return;
        if (output.overflow) job.error = "Action exceeded its output limit.";
        job.status = output.code === 0 && !job.error ? "succeeded" : "failed";
        if (output.code !== 0 && !job.error) job.error = "Action failed. Run the equivalent oflow command in your terminal for details.";
        if (!output.overflow && output.stdout && job.error !== "Action exceeded its time limit.") {
          try {
            const parsed: unknown = JSON.parse(output.stdout);
            const secrets = environmentSecrets();
            job.result = projectDashboardActionResult(parsed, secrets);
          } catch { job.status = "failed"; job.error = "Action returned an invalid JSON result."; }
        }
      }).catch(() => { if (job.status !== "cancelled") { job.status = "failed"; job.error = "Action could not be completed."; } })
        .finally(() => { clearTimeout(timer); job.finishedAt = new Date().toISOString(); if (this.active?.job === job) this.active = null; this.persist(); });
      return structuredClone(job);
    } finally { this.starting = false; }
  }
  cancel(id: string): DashboardJob | null {
    const job = this.jobs.find((entry) => entry.id === id);
    if (!job) return null;
    if (this.active?.job === job && job.status === "running") {
      job.status = "cancelled";
      this.active.process.terminate();
      this.persist();
    }
    return structuredClone(job);
  }
  close(): void { if (this.active) this.cancel(this.active.job.id); }
}

function environmentSecrets(): string[] {
  return Object.entries(process.env).filter(([key]) => /token|secret|password|credential/i.test(key)).map(([, value]) => value ?? "");
}
