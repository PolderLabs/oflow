import type { AuthCapability } from "./types.js";
import { probeCapabilities, resolveAuth } from "./auth-resolver.js";
import { detectBackends, type BackendStatus } from "./backends.js";
import {
  probeTransport,
  type TransportState,
  type TransportProbe as TransportProbeSnapshot,
} from "./transport.js";
import { OflowError } from "./errors.js";

export type CapabilityState = "implemented" | "planned" | "optional";

export interface Capability {
  id: string;
  state: CapabilityState;
  access: "read" | "plan-only" | "apply";
  resource: string;
  backend: string;
  permission: string;
  /** Qualification surfaced in rendered output (e.g. type-coverage limits). */
  note?: string;
}

/** Per-capability lifecycle ownership slice (Slice A — D2 "both" shape). */
export interface CapabilityStateOwnership {
  /**
   * Subset of TransportState this capability uniquely owns. Read capabilities
   * own nothing mutable; write capabilities own the `mutable` slice (whether
   * the resolution's mutation transport accepts this access class). The
   * remaining lifecycle (configured/authenticated/readable/verifiable) lives
   * on `CapabilitiesResult.transport` and is shared across capabilities.
   */
  mutable: boolean | "runtime-owned" | "unsupported";
  verifiable: boolean | "runtime-owned" | "unsupported";
}

export interface CapabilitiesOptions {
  /** When provided, oflow probes the live backend and returns per-capability usability. */
  probe?: {
    root: string;
    host: string;
    projectPath?: string;
  };
}

/**
 * Slice A transport snapshot mounted on the result. Distinct from
 * `probes` (per-capability F2 snapshot) so callers can read lifecycle
 * once and capability usability per row.
 */
export interface CapabilitiesTransport {
  host: string;
  state: TransportState;
  readBackend: TransportProbeSnapshot["resolved"]["readBackend"];
  mutationBackend: TransportProbeSnapshot["resolved"]["mutationBackend"];
  sources: TransportProbeSnapshot["sources"];
  notes: string[];
}

export interface CapabilitiesResult {
  generatedAt: string;
  backends: BackendStatus;
  capabilities: Capability[];
  /**
   * 5-state transport lifecycle for the probed host. Present only when
   * `options.probe.host` is supplied; absent when capabilities are
   * surfaced in declarative form.
   */
  transport?: CapabilitiesTransport;
  /** F2 probe results; present only when probing a project-scoped host. */
  probes?: AuthCapability[];
  /**
   * Per-capability lifecycle ownership slice (D2 "both"). Indexed by
   * capability id. Read capabilities get `{mutable: false,
   * verifiable: false}` since mutation is structurally unavailable to
   * them; write capabilities inherit lifecycle from
   * `transport.state.mutable` / `verifiable`.
   */
  perCapabilityState?: Record<string, CapabilityStateOwnership>;
  reduced: boolean;
}
export async function getCapabilities(options: CapabilitiesOptions = {}): Promise<CapabilitiesResult> {
  let transport: CapabilitiesTransport | undefined;
  let perCapabilityState: Record<string, CapabilityStateOwnership> | undefined;
  let probes: AuthCapability[] | undefined;
  let reduced = false;

  if (options.probe) {
    if (options.probe.projectPath === undefined) {
      throw new OflowError(
        "oflow capabilities --probe requires --project to identify the host scope. " +
          "Use --probe --project <path> or omit --probe for the declarative catalog.",
        "MISSING_PROJECT_PATH_FOR_PROBE",
      );
    }
    const probe = await probeTransport({
      host: options.probe.host,
      root: options.probe.root,
      projectPath: options.probe.projectPath,
    });
    transport = {
      host: probe.host,
      state: probe.state,
      readBackend: probe.resolved.readBackend,
      mutationBackend: probe.resolved.mutationBackend,
      sources: probe.sources,
      notes: probe.resolved.notes,
    };
    probes = probe.capabilities;
    perCapabilityState = buildPerCapabilityState(
      probe.state,
      CAPABILITY_DEFINITIONS.map((def) => def.id),
    );
    if (
      probe.state.readable !== true ||
      probe.state.mutable === "unsupported"
    ) {
      reduced = true;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    backends: await detectBackends(),
    capabilities: [
      capability(
        "project.read",
        "implemented",
        "read",
        "Project",
        "REST",
        "Project: Read",
      ),
      capability(
        "work-items.read",
        "implemented",
        "read",
        "Work Item",
        "REST",
        "Work Item: Read",
        "Covers issue and task types only; custom work-item types (e.g. User Story, EPIC) are invisible to REST listings. oflow emits a type-coverage warning when a GraphQL census finds items REST cannot see.",
      ),
      capability(
        "story.context",
        "implemented",
        "read",
        "Issue, notes, merge requests, pipelines",
        "REST",
        "Project: Read; Work Item: Read",
      ),
      capability(
        "merge-requests.read",
        "implemented",
        "read",
        "Merge Request",
        "REST",
        "Project: Read",
      ),
      capability(
        "pipelines.read",
        "implemented",
        "read",
        "Pipeline",
        "REST",
        "Project: Read",
      ),
      capability(
        "planning.sync",
        "implemented",
        "read",
        "Work items, parent context, labels, milestones, boards, iterations",
        "REST",
        "Project: Read; Group: Read; Work Item: Read",
      ),
      capability(
        "iterations.read",
        "implemented",
        "read",
        "Project-visible or parent-group iterations/sprints",
        "REST",
        "Project: Read; Group: Read when using --group",
      ),
      capability(
        "iteration-cadences.read",
        "implemented",
        "read",
        "Parent-group sprint cadence schedule",
        "GraphQL",
        "Group: Read; Iteration: Read",
      ),
      capability(
        "merge-requests.write",
        "implemented",
        "apply",
        "Merge Request",
        "direct REST plus delegated create",
        "Project: Write; optional create fallback via `git push -o merge_request.create`",
        "Plan-backed direct execution supports MR create/update. `oflow apply --delegate` supports MR create only through runtime-owned GitLab MCP; `git push -o merge_request.create` is a separate Git transport fallback, not MCP. Delegated MR update is not implemented.",
      ),

      capability(
        "work-items.bulk-labels.update",
        "implemented",
        "apply",
        "Work Item (REST) / Issue",
        "REST",
        "Work Item: Write",
        "Operates on issue and task types only; custom work-item types are not reachable through REST issue endpoints.",
      ),
      capability(
        "issue.note",
        "implemented",
        "apply",
        "Work Item note",
        "REST",
        "Work Item: Write; Notes: Read",
      ),
      capability(
        "label.create",
        "implemented",
        "apply",
        "Label",
        "REST",
        "Project: Write; Label: Write",
      ),
      capability(
        "milestone.create",
        "implemented",
        "apply",
        "Milestone",
        "REST",
        "Project: Write; Milestone: Write",
      ),
      capability(
        "board.create",
        "implemented",
        "apply",
        "Board",
        "REST",
        "Project: Write; Board: Write",
      ),
      capability(
        "iteration.assign",
        "implemented",
        "apply",
        "Project-visible or parent-group iteration",
        "REST",
        "Project: Write; Iteration: Write",
      ),
      capability(
        "labels.bulk-update",
        "implemented",
        "plan-only",
        "Work Item labels (1-50 per plan)",
        "REST",
        "Work Item: Write",
        "Apply runs under plan → approve → apply → verify; bulk plans cap at 50 IIDs and every IID read re-checks the stale digest before each mutation.",
      ),
      capability(
        "labels.audit",
        "planned",
        "read",
        "Label coverage across work items",
        "REST + GraphQL",
        "Work Item: Read",
        "Future slice (ROADMAP friction #9); must carry the type-coverage warning so audits over REST listings cannot claim completeness for invisible custom-type items (issue #4).",
      ),
    ],
    ...(transport ? { transport } : {}),
    ...(probes ? { probes } : {}),
    ...(perCapabilityState ? { perCapabilityState } : {}),
    reduced,
  };
}

/** Read/write classification used by the per-capability ownership slice. */
interface InternalDefinition {
  id: string;
  access: "read" | "write";
}

/**
 * Subset of the canonical capability list exposed by `auth-resolver.ts`.
 * Kept in sync manually until slice A's one-source refactor lands; both
 * lists must end the release describing the same capability ids.
 */
const CAPABILITY_DEFINITIONS: InternalDefinition[] = [
  { id: "project.read", access: "read" },
  { id: "work-items.read", access: "read" },
  { id: "story.context", access: "read" },
  { id: "merge-requests.read", access: "read" },
  { id: "pipelines.read", access: "read" },
  { id: "planning.sync", access: "read" },
  { id: "iterations.read", access: "read" },
  { id: "iteration-cadences.read", access: "read" },
  { id: "merge-requests.write", access: "write" },
  { id: "work-items.bulk-labels.update", access: "write" },
  { id: "issue.note", access: "write" },
  { id: "label.create", access: "write" },
  { id: "milestone.create", access: "write" },
  { id: "board.create", access: "write" },
  { id: "iteration.assign", access: "write" },
  { id: "labels.bulk-update", access: "write" },
  { id: "labels.audit", access: "read" },
];

export function buildPerCapabilityState(
  transportState: TransportState,
  capabilityIds: readonly string[],
): Record<string, CapabilityStateOwnership> {
  const out: Record<string, CapabilityStateOwnership> = {};
  for (const def of CAPABILITY_DEFINITIONS) {
    if (!capabilityIds.includes(def.id)) continue;
    if (def.access === "read") {
      out[def.id] = { mutable: false, verifiable: false };
    } else {
      out[def.id] = {
        mutable: transportState.mutable,
        verifiable: transportState.verifiable,
      };
    }
  }
  return out;
}

export function formatCapabilitiesMarkdown(result: CapabilitiesResult): string {
  const lines = [
    "# oflow capabilities",
    "",
    "Generated: " + result.generatedAt,
    "REST core: available",
    "glab fallback: " +
      (result.backends.glab.available
        ? "available" + (result.backends.glab.version ? " (" + result.backends.glab.version + ")" : "")
        : "not installed"),
    "MCP: agent-runtime optional",
    "",
  ];
  if (result.transport) {
    lines.push(
      "Transport lifecycle (Slice A): configured=" +
        result.transport.state.configured +
        ", authenticated=" +
        result.transport.state.authenticated +
        ", readable=" +
        result.transport.state.readable +
        ", mutable=" +
        result.transport.state.mutable +
        ", verifiable=" +
        result.transport.state.verifiable,
    );
    if (result.reduced) {
      lines.push(
        "Mode: reduced — at least one lifecycle state is missing or unsupported.",
      );
    }
    lines.push("");
  }
  lines.push(
    "| Capability | State | Access | Resource | Backend | Permission | Note |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...result.capabilities.map(
      (item) =>
        "| " +
        item.id +
        " | " +
        item.state +
        " | " +
        item.access +
        " | " +
        item.resource +
        " | " +
        item.backend +
        " | " +
        item.permission +
        " | " +
        (item.note ?? "") +
        " |",
    ),
  );
  if (result.probes && result.probes.length > 0) {
    lines.push(
      "",
      "Live capability probes (F2):",
      "| Capability | Usable | Probe | Backend | Source | Reason |",
      "| --- | --- | --- | --- | --- | --- |",
      ...result.probes.map((cap) =>
        "| " + cap.id + " | " + (cap.usable ? "yes" : "no") +
        " | " + cap.probe + " | " + cap.backend +
        " | " + (cap.source ?? "-") + " | " + (cap.reason ?? "-") + " |",
      ),
      "",
    );
  }
  if (
    result.transport &&
    result.perCapabilityState &&
    Object.keys(result.perCapabilityState).length > 0
  ) {
    lines.push(
      "Per-capability lifecycle (subset owned by each capability):",
      "| Capability | Mutable | Verifiable |",
      "| --- | --- | --- |",
      ...Object.entries(result.perCapabilityState).map(
        ([id, ownership]) =>
          "| " +
          id +
          " | " +
          ownership.mutable +
          " | " +
          ownership.verifiable +
          " |",
      ),
      "",
    );
  }
  return lines.join("\n");
}

function capability(
  id: string,
  state: CapabilityState,
  access: Capability["access"],
  resource: string,
  backend: string,
  permission: string,
  note?: string,
): Capability {
  return note === undefined ? { id, state, access, resource, backend, permission } : { id, state, access, resource, backend, permission, note };
}
