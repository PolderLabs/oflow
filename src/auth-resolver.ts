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

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getGitLabTokenSource, listStoredGitLabHosts } from "./auth.js";
import type { GitLabAuthCandidate } from "./types.js";

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
