/**
 * Transport lifecycle (Slice A — must-ship ROADMAP #83).
 *
 * Distinct from `BackendStatus` (runtime presence — is glab installed?) and
 * from per-capability probe results (what one capability can do). The
 * transport lifecycle captures whether a given host is reachable through a
 * given transport:
 *
 *   configured     : an auth source exists for this host (env, glab,
 *                    oflow-store, ci-job-token, or mcp-runtime).
 *   authenticated  : that source has produced a usable session, OR for MCP
 *                    the runtime declares it owns the OAuth session.
 *                    "runtime-owned" is an explicit third value — not a
 *                    boolean — because we cannot prove it from inside oflow.
 *   readable       : a read transport can reach the host (REST/GraphQL).
 *   mutable        : a write transport can reach the host. "runtime-owned"
 *                    when an MCP runtime is the only mutation path,
 *                    "unsupported" when no write transport was resolved
 *                    (e.g. oflow-store with a read-only token).
 *   verifiable     : a successful mutation can be re-read back through the
 *                    same host. Today this collapses to "mutable is not
 *                    false" because every GitLab write has a matching read
 *                    in REST; left explicit so future transports
 *                    (e.g. event-driven) can downgrade it.
 *
 * The probe is heuristic-only; it MUST NOT call write endpoints. The
 * doctor contract forbids write probes. If a future release needs
 * scope-accurate `mutable`, do it via `/personal_access_tokens/self`
 * (read-only) — never a mutation test.
 */
import { detectBackends, type BackendStatus } from "./backends.js";
import {
  resolveAuth,
  type AuthResolution,
  type ProbeCapabilitiesOptions,
  probeCapabilities,
} from "./auth-resolver.js";
import type { AuthCapability, GitLabAuthCandidate } from "./types.js";

export interface TransportState {
  /** At least one credential source was found for the host. */
  configured: boolean;
  /**
   * The auth source is usable. "runtime-owned" is reserved for MCP:
   * we detect the configuration but cannot prove session liveness.
   */
  authenticated: boolean | "runtime-owned";
  /** A read transport can reach the host. */
  readable: boolean;
  /**
   * A mutation transport can perform writes from oflow.
   *   - "runtime-owned" — MCP runtime owns the mutation OAuth.
   *   - "unsupported"   — no write transport resolved; refuse mutations.
   */
  mutable: boolean | "runtime-owned" | "unsupported";
  /**
   * A mutation can be re-read to verify it landed. Mirrors `mutable` for now;
   * future transports that lack re-read must downgrade this independently.
   */
  verifiable: boolean | "runtime-owned" | "unsupported";
}

export interface TransportProbeOptions {
  host: string;
  root: string;
  projectPath?: string;
  /** Skip MCP runtime detection (used in tests). */
  detectMcp?: boolean;
  /** Per-probe timeout, forwarded from the existing capability probe. */
  perProbeTimeoutMs?: number;
}

export interface TransportProbe {
  host: string;
  /** Backend presence snapshot (kept here so callers don't import backends.ts). */
  backends: BackendStatus;
  sources: GitLabAuthCandidate[];
  resolved: Pick<
    AuthResolution,
    "readBackend" | "mutationBackend" | "notes"
  >;
  state: TransportState;
  /** Per-capability probes (F2). May be `undefined` when none ran. */
  capabilities?: AuthCapability[];
}

/**
 * Compute the lifecycle state from an already-resolved auth snapshot.
 *
 * `resolveAuth` collapsed source.authenticated into the boolean on
 * AuthResolution (any true source OR any runtime-owned MCP source yields
 * `authenticated: true`). We only re-promote the value to "runtime-owned"
 * when an MCP source is among the discovered credentials, since we cannot
 * prove its session liveness from inside oflow.
 */
export function deriveTransportState(
  resolution: Pick<
    AuthResolution,
    "sources" | "readBackend" | "mutationBackend" | "authenticated"
  >,
): TransportState {
  const sources = resolution.sources;
  const configured = sources.length > 0;

  const mcpPresent = sources.some(
    (source) => source.source === "mcp-runtime",
  );
  const authenticated: TransportState["authenticated"] =
    resolution.authenticated
      ? mcpPresent
        ? "runtime-owned"
        : true
      : false;

  const readable = resolution.readBackend !== "none";

  const mutable: TransportState["mutable"] =
    resolution.mutationBackend === "gitlab-mcp"
      ? "runtime-owned"
      : resolution.mutationBackend === "none"
        ? "unsupported"
        : true;

  const verifiable: TransportState["verifiable"] =
    mutable === "unsupported" ? "unsupported" : mutable;

  return {
    configured,
    authenticated,
    readable,
    mutable,
    verifiable,
  };
}

export async function probeTransport(
  options: TransportProbeOptions,
): Promise<TransportProbe> {
  const detectMcp = options.detectMcp ?? true;
  const resolution = await resolveAuth({
    host: options.host,
    root: options.root,
    ...(detectMcp === false ? { detectMcp: false } : {}),
  });
  const state = deriveTransportState(resolution);

  let capabilities: AuthCapability[] | undefined;
  if (options.projectPath !== undefined) {
    const probeOptions: ProbeCapabilitiesOptions = {
      host: options.host,
      projectPath: options.projectPath,
      ...(options.perProbeTimeoutMs !== undefined
        ? { perProbeTimeoutMs: options.perProbeTimeoutMs }
        : {}),
    };
    capabilities = await probeCapabilities(
      probeOptions,
      resolution.sources,
      resolution.readBackend,
    );
  }

  return {
    host: resolution.host,
    backends: await detectBackends(),
    sources: resolution.sources,
    resolved: {
      readBackend: resolution.readBackend,
      mutationBackend: resolution.mutationBackend,
      notes: resolution.notes,
    },
    state,
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
}
