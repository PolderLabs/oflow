/**
 * Smart authentication resolution (vNext architecture, PR 2).
 *
 * Discovers every credential source for the resolved GitLab host and picks a
 * backend without ever exposing token material. Sources:
 *
 *   - agent-runtime GitLab MCP (runtime-owned OAuth, never scraped)
 *   - glab CLI (credentials owned by glab)
 *   - environment variables
 *   - the oflow credential store
 *   - GitLab CI job token
 */

import { GitLabClient } from "./gitlab.js";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getGitLabTokenSource, listStoredGitLabHosts } from "./auth.js";
import type { AuthCapability, GitLabAuthCandidate } from "./types.js";

export type { AuthCapability } from "./types.js";

const execFile = promisify(execFileCallback);

export interface AuthResolution {
  host: string;
  sources: GitLabAuthCandidate[];
  /** Preferred read/verification transport following the vNext priority. */
  readBackend: "glab" | "rest" | "graphql" | "none";
  /** Preferred agent-delegated mutation transport. */
  mutationBackend: "gitlab-mcp" | "glab" | "rest" | "graphql" | "none";
  authenticated: boolean;
  notes: string[];
  /** Per-capability usability snapshot (F2); present only when probed. */
  capabilities?: AuthCapability[];
}

export interface AuthResolverOptions {
  host: string;
  root?: string;
  /** Detect MCP configuration even when glab/env credentials exist. */
  detectMcp?: boolean;
  /** Override glab binary for tests (same override the glab adapter uses). */
  glabBinary?: string;
}

/** Result of inspecting glab authentication for one host. */
export interface GlabAuthStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  host: string;
}

export async function resolveAuth(options: AuthResolverOptions): Promise<AuthResolution> {
  const host = options.host;
  const sources: GitLabAuthCandidate[] = [];
  const notes: string[] = [];

  // CI job token: only meaningful inside GitLab CI, capability-limited.
  if (process.env.GITLAB_CI === "true" && process.env.CI_JOB_TOKEN) {
    sources.push({
      host,
      source: "ci-job-token",
      authenticated: true,
      interactive: false,
      backendCompatibility: ["rest (job-token scoped)"],
      notes: ["Job token capabilities are limited to the CI job context."],
    });
    notes.push("CI job token detected; capabilities are job-scoped.");
  }

  // Environment token: recognized standard GitLab variables, never echoed.
  const tokenSource = getGitLabTokenSource(host);
  if (tokenSource?.kind === "environment") {
    sources.push({
      host,
      source: "environment",
      authenticated: true,
      interactive: false,
      backendCompatibility: ["rest", "graphql"],
      notes: ["Environment token detected (" + tokenSource.variable + ")."],
    });
  }

  // glab: reuse an existing authenticated session instead of forcing a
  // second GitLab login for oflow.
  const glab = await glabAuthStatus(host, options.glabBinary);
  if (glab.installed) {
    sources.push({
      host,
      source: "glab",
      authenticated: glab.authenticated,
      interactive: false,
      backendCompatibility: ["glab api reads", "glab api mutations"],
      notes: glab.authenticated
        ? []
        : ["glab is installed but not authenticated; run `glab auth login`."],
    });
  }

  // oflow store: per-host isolated credentials outside the repository.
  const storedHosts = listStoredGitLabHosts();
  if (storedHosts.includes(host)) {
    sources.push({
      host,
      source: "oflow-store",
      authenticated: true,
      interactive: false,
      backendCompatibility: ["rest", "graphql"],
      notes: ["Stored oflow credential for this host."],
    });
  }

  // Agent-runtime GitLab MCP: configuration detected != authenticated. The
  // OAuth session belongs to the runtime; oflow never scrapes its caches.
  if (options.detectMcp !== false) {
    const mcp = await detectRuntimeGitLabMcp(options.root ?? process.cwd(), host);
    if (mcp.configured) {
      sources.push({
        host,
        source: "mcp-runtime",
        authenticated: "runtime-owned",
        interactive: false,
        backendCompatibility: ["delegated MCP actions"],
        notes: [
          "Configuration detected does not equal authenticated; the agent runtime owns the OAuth session.",
        ],
      });
      notes.push(
        "GitLab MCP configuration detected in " + mcp.source + "; auth state is runtime-owned.",
      );
    }
  }

  const authenticated = sources.some(
    (candidate) => candidate.authenticated === true || candidate.authenticated === "runtime-owned",
  );

  return {
    host,
    sources,
    readBackend: pickReadBackend(sources),
    mutationBackend: pickMutationBackend(sources),
    authenticated,
    notes,
  };
}

// Priority: explicit environment token > authenticated glab > store/CI.
function pickReadBackend(sources: GitLabAuthCandidate[]): AuthResolution["readBackend"] {
  if (sources.some((source) => source.source === "environment")) return "rest";
  if (sources.some((source) => source.source === "glab" && source.authenticated === true)) {
    return "glab";
  }
  if (
    sources.some(
      (source) => source.source === "ci-job-token" || source.source === "oflow-store",
    )
  ) {
    return "rest";
  }
  return "none";
}

// MCP runtime-owned sessions win for delegated mutation, then glab, then
// direct credentials.
function pickMutationBackend(sources: GitLabAuthCandidate[]): AuthResolution["mutationBackend"] {
  if (sources.some((source) => source.source === "mcp-runtime")) return "gitlab-mcp";
  if (sources.some((source) => source.source === "glab" && source.authenticated === true)) {
    return "glab";
  }
  if (
    sources.some(
      (source) =>
        source.source === "environment" ||
        source.source === "ci-job-token" ||
        source.source === "oflow-store",
    )
  ) {
    return "rest";
  }
  return "none";
}

/** Host-scoped glab authentication check; never extracts or prints a token. */
export async function glabAuthStatus(
  host: string,
  binaryOverride?: string,
): Promise<GlabAuthStatus> {
  const binary = binaryOverride ?? process.env.OFLOW_GLAB_BIN?.trim() ?? "glab";
  let version: string | null = null;
  try {
    const result = await execFile(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const output = result.stdout + "\n" + result.stderr;
    const match = output.match(/glab version\s+([^\s]+)/i);
    version = match?.[1] ?? (output.trim().split(/\r?\n/, 1)[0] || null);
  } catch {
    return { installed: false, version: null, authenticated: false, host };
  }
  try {
    await execFile(binary, ["auth", "status", "--hostname", host], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    return { installed: true, version, authenticated: true, host };
  } catch {
    return { installed: true, version, authenticated: false, host };
  }
}

/**
 * Detect runtime GitLab MCP configuration for the host without scraping
 * OAuth caches: configuration detected != authenticated.
 */
export async function detectRuntimeGitLabMcp(
  root: string,
  host: string,
): Promise<{ configured: true; source: string } | { configured: false; source: null }> {
  const expectedUrl = "https://" + host + "/api/v4/mcp";
  const candidates = [
    { source: ".omp/mcp.json", path: join(root, ".omp", "mcp.json") },
    { source: ".mcp.json", path: join(root, ".mcp.json") },
  ];
  for (const candidate of candidates) {
    let text: string;
    try {
      text = await readFile(candidate.path, "utf8");
    } catch {
      continue;
    }
    if (text.includes(expectedUrl)) {
      return { configured: true, source: candidate.source };
    }
  }
  return { configured: false, source: null };
}
/** Normalize HTTP 403/401 probe failures into oflow-level remediation hints.
 * Accepts the raw error so callers can branch on numeric status from
 * `GitLabApiError`; falls back to message regex when the error is opaque. */
export function normalizeForbidden(error: unknown): {
  reason: string;
  remediation?: string;
  probe: "forbidden" | "failed";
} {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
  let numericStatus: number | null = null;
  if (error !== null && typeof error === "object" && "status" in error) {
    const status = error.status;
    if (typeof status === "number") numericStatus = status;
  }
  const compact = message.replace(/\s+/g, " ").slice(0, 300);
  if (numericStatus === 403 || /403 Forbidden/i.test(compact)) {
    return {
      reason: compact + " (HTTP 403 forbidden)",
      remediation:
        "Use a token with broader scopes (api, read_api) or `glab auth login`. " +
        "For MR writes prefer `oflow mr create --delegate` or " +
        "`git push -o merge_request.create`.",
      probe: "forbidden",
    };
  }
  if (numericStatus === 401 || /401 Unauthorized/i.test(compact)) {
    return {
      reason: compact + " (HTTP 401 unauthorized)",
      remediation:
        "Re-authenticate with `oflow auth login <host>` or set GITLAB_TOKEN. " +
        "Confirm the token has not been revoked or expired.",
      probe: "forbidden",
    };
  }
  return { reason: compact, probe: "failed" };
}

export interface ProbeCapabilitiesOptions {
  host: string;
  /** Project-scoped REST probes are skipped when the project path is unknown. */
  projectPath?: string;
  /** Allow callers to inject a pre-built client (test seam). */
  clientFactory?: (host: string) => GitLabClient;
  /** Hard timeout per probe to keep doctor/capabilities responsive. */
  perProbeTimeoutMs?: number;
}

interface CapabilityDefinition {
  id: string;
  backend: AuthCapability["backend"];
  access: "read" | "write";
  required: boolean;
  probe?: (client: GitLabClient, projectPath: string) => Promise<unknown>;
}

const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
  { id: "user.read", backend: "rest", access: "read", required: true,
    probe: (client) => client.getCurrentUser() },
  { id: "project.read", backend: "rest", access: "read", required: true,
    probe: (client, projectPath) => client.getProject(projectPath) },
  { id: "work-items.read", backend: "rest", access: "read", required: true,
    probe: (client, projectPath) => client.listIssuesPage(projectPath, "opened", 1) },
  { id: "merge-requests.read", backend: "rest", access: "read", required: true,
    probe: (client, projectPath) => client.listMergeRequestsPage(projectPath, undefined, "opened", 1) },
  { id: "pipelines.read", backend: "rest", access: "read", required: true,
    probe: (client, projectPath) => client.listPipelinesPage(projectPath, null, 1) },
  { id: "labels.read", backend: "rest", access: "read", required: true,
    probe: (client, projectPath) => client.listLabelsPage(projectPath, 1) },
  { id: "milestones.read", backend: "rest", access: "read", required: true,
    probe: (client, projectPath) => client.listMilestonesPage(projectPath, "active", 1) },
  { id: "boards.read", backend: "rest", access: "read", required: true,
    probe: (client, projectPath) => client.listBoardsPage(projectPath, 1) },
  { id: "merge-requests.write", backend: "rest", access: "write", required: false },
  { id: "work-items.update", backend: "rest", access: "write", required: true },
  { id: "notes.write", backend: "rest", access: "write", required: true },
  { id: "labels.write", backend: "rest", access: "write", required: true },
  { id: "milestones.write", backend: "rest", access: "write", required: true },
  { id: "boards.write", backend: "rest", access: "write", required: true },
  { id: "iteration-assignment.write", backend: "graphql", access: "write", required: true },
];

/**
 * Build the per-capability usability snapshot. Read-only probes run against
 * the resolved REST transport when credentials allow; write capabilities are
 * labelled but never probed, matching the doctor contract.
 */

/** Await `operation()` with a hard timeout; rejects with a timeout error. */
async function runWithTimeout(
  operation: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("probe timed out after " + timeoutMs + "ms")),
      timeoutMs,
    );
    operation().then(
      () => resolve(),
      (error) => reject(error),
    ).finally(() => clearTimeout(timer));
  });
}
export async function probeCapabilities(
  options: ProbeCapabilitiesOptions,
  sources: GitLabAuthCandidate[],
  readBackend: AuthResolution["readBackend"],
): Promise<AuthCapability[]> {
  const perProbeTimeoutMs = options.perProbeTimeoutMs ?? 5000;
  const clientFactory = options.clientFactory ?? ((host: string) => new GitLabClient(host));
  const client = options.projectPath && readBackend !== "none" ? clientFactory(options.host) : null;
  const results: AuthCapability[] = [];

  for (const def of CAPABILITY_DEFINITIONS) {
    let source: string | undefined;
    for (const candidate of ["environment", "oflow-store", "ci-job-token", "glab"]) {
      if (sources.some((s) => s.source === candidate && s.authenticated === true)) {
        source = candidate;
        break;
      }
    }
    if (!source && def.backend === "gitlab-mcp" && sources.some((s) => s.source === "mcp-runtime")) {
      source = "mcp-runtime";
    }
    const baseBackend: AuthCapability["backend"] =
      def.backend === "graphql" && readBackend === "rest" ? "rest" : def.backend;

    if (def.access === "write") {
      const mcpUsable = sources.some((s) => s.source === "mcp-runtime");
      if (mcpUsable) {
        results.push({
          id: def.id,
          usable: true,
          probe: "not-probed",
          backend: "gitlab-mcp",
          source: "mcp-runtime",
          reason: "MCP runtime owns the OAuth session; verify by `oflow apply` after approval.",
        });
        continue;
      }
      results.push({
        id: def.id, usable: false, probe: "not-probed", backend: baseBackend, source,
        reason: "doctor never runs a write probe; verify by `oflow apply` after approval.",
      });
      continue;
    }
    if (!def.probe) {
      results.push({
        id: def.id, usable: false, probe: "skipped", backend: baseBackend,
        reason: "no probe handler registered",
      });
      continue;
    }
    if (!client || !options.projectPath) {
      results.push({
        id: def.id, usable: false, probe: "skipped", backend: baseBackend, source,
        reason: options.projectPath
          ? "no authenticated read transport"
          : "project path not yet resolved (run inside a GitLab checkout)",
      });
      continue;
    }

    try {
      await runWithTimeout(
        () => def.id === "user.read"
          ? client.getCurrentUser()
          : def.probe!(client, options.projectPath!),
        perProbeTimeoutMs,
      );
      results.push({
        id: def.id, usable: true, probe: "passed", backend: baseBackend, source,
        reason: def.id === "user.read"
          ? "current user resolved via GitLab /user"
          : "read endpoint responded successfully",
      });
    } catch (error) {
      const { reason, remediation, probe } = normalizeForbidden(error);
      results.push({
        id: def.id,
        usable: false,
        probe,
        backend: baseBackend,
        source,
        reason,
        remediation,
      });
    }
  }
  return results;
}
