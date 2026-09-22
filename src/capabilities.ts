import type { AuthCapability } from "./types.js";
import { probeCapabilities, resolveAuth } from "./auth-resolver.js";
import { detectBackends, type BackendStatus } from "./backends.js";

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

export interface CapabilitiesOptions {
  /** When provided, oflow probes the live backend and returns per-capability usability. */
  probe?: {
    root: string;
    host: string;
    projectPath?: string;
  };
}

export interface CapabilitiesResult {
  generatedAt: string;
  backends: BackendStatus;
  capabilities: Capability[];
  /** F2 probe results; absent when no probe was requested or one could not be run. */
  probes?: AuthCapability[];
}
export async function getCapabilities(options: CapabilitiesOptions = {}): Promise<CapabilitiesResult> {
  const probes = options.probe
    ? await (async (): Promise<AuthCapability[]> => {
      const resolution = await resolveAuth({ host: options.probe!.host, root: options.probe!.root });
      return probeCapabilities(
        {
          host: options.probe!.host,
          ...(options.probe!.projectPath ? { projectPath: options.probe!.projectPath } : {}),
        },
        resolution.sources,
        resolution.readBackend,
      );
    })()
    : undefined;

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
        "Group: Read; Iteration: Read (tier/version dependent)",
      ),
      capability(
        "group-epics.read",
        "implemented",
        "read",
        "Group epics and parent/child hierarchy",
        "GraphQL",
        "Group: Read; Work Item: Read",
      ),
      capability(
        "work-items.create",
        "implemented",
        "apply",
        "Work Item",
        "REST",
        "Work Item: Create; User: Read when resolving usernames",
      ),
      capability(
        "work-items.update",
        "implemented",
        "apply",
        "Work Item",
        "REST",
        "Work Item: Update (including epic association); User: Read when resolving usernames",
      ),
      capability(
        "iteration-assignment.write",
        "implemented",
        "apply",
        "Work Item iteration assignment",
        "GraphQL",
        "Project: Update (Mutation: IssueSetIteration); Project: Read for target iteration lookup",
      ),
      capability(
        "work-items.bulk-iteration.update",
        "implemented",
        "apply",
        "Work Item iteration assignment (up to 50 issues)",
        "GraphQL",
        "Project: Update (Mutation: IssueSetIteration); Project: Read for target iteration lookup",
      ),
      capability(
        "work-items.bulk-labels.update",
        "implemented",
        "apply",
        "Work Item labels",
        "REST",
        "Work Item: Update; Label: Read is recommended for planning",
        "Operates on issue and task types only; custom work-item types are not reachable through REST issue endpoints.",
      ),
      capability(
        "work-items.bulk-planning.update",
        "implemented",
        "apply",
        "Work Item owner and milestone/timebox",
        "REST",
        "Work Item: Update; User: Read when resolving usernames",
      ),
      capability(
        "notes.write",
        "implemented",
        "apply",
        "Issue note",
        "REST",
        "Work Item: Update",
      ),
      capability(
        "labels.write",
        "implemented",
        "apply",
        "Label",
        "REST",
        "Label: Create/Update",
      ),
      capability(
        "milestones.write",
        "implemented",
        "apply",
        "Project milestone",
        "REST",
        "Project Planning: Create/Update",
      ),
      capability(
        "boards.write",
        "implemented",
        "apply",
        "Board and board list",
        "REST",
        "Project Planning: Create/Update; Label: Read for label-backed lists",
      ),
      capability(
        "merge-requests.write",
        "implemented",
        "apply",
        "Merge Request",
        "REST, glab, or MCP",
        "Merge Request: Update (direct); Create stays delegated to the agent runtime",
      ),
      capability(
        "glab.fallback",
        "optional",
        "read",
        "Unwrapped GitLab endpoints",
        "glab api",
        "Depends on endpoint",
      ),
      capability(
        "audit.read",
        "implemented",
        "read",
        "Local plan lifecycle history",
        "local JSONL",
        "No GitLab permission",
      ),
      capability(
        "planning.cache.read",
        "implemented",
        "read",
        "Local sync and work-item snapshots",
        "local JSON + SQLite",
        "No GitLab permission; use --cached explicitly",
      ),
      capability(
        "planning.dashboard.read",
        "implemented",
        "read",
        "Local planning, delivery, and sync-history read model",
        "SQLite + loopback HTTP",
        "No GitLab permission; dashboard never receives credentials",
      ),
      capability(
        "planning.cache.status",
        "implemented",
        "read",
        "Local cache age, schema, invalidation, and refresh diagnostics",
        "local SQLite",
        "No GitLab permission",
      ),
      capability(
        "agent.context.read",
        "implemented",
        "read",
        "Compact machine-readable planning context",
        "CLI JSON contract",
        "No additional permission; agents use oflow sync/work reads",
      ),
      capability(
        "assessment.plan",
        "implemented",
        "plan-only",
        "Owner/timebox update derived from a story assessment",
        "REST + local assessment",
        "Work Item: Read; User: Read for username lookup",
      ),
      capability(
        "assessment.read",
        "implemented",
        "read",
        "Acceptance criteria with bounded local code/test references",
        "REST + local Git",
        "Work Item: Read",
      ),
    ],
    ...(probes ? { probes } : {}),
  };
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
  ];
  if (result.probes && result.probes.length > 0) {
    lines.push(
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
