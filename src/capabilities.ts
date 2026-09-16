import { detectBackends, type BackendStatus } from "./backends.js";

export type CapabilityState = "implemented" | "planned" | "optional";

export interface Capability {
  id: string;
  state: CapabilityState;
  access: "read" | "plan-only" | "apply";
  resource: string;
  backend: string;
  permission: string;
}

export interface CapabilitiesResult {
  generatedAt: string;
  backends: BackendStatus;
  capabilities: Capability[];
}

export async function getCapabilities(): Promise<CapabilitiesResult> {
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
        "work-items.bulk-labels.update",
        "implemented",
        "apply",
        "Work Item labels",
        "REST",
        "Work Item: Update; Label: Read is recommended for planning",
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
        "planned",
        "plan-only",
        "Merge Request",
        "REST, glab, or MCP",
        "Merge Request: Create/Update",
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
        "Local sync snapshot",
        "local JSON",
        "No GitLab permission; use --cached explicitly",
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
    "| Capability | State | Access | Resource | Backend | Permission |",
    "| --- | --- | --- | --- | --- | --- |",
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
        " |",
    ),
    "",
  ];
  return lines.join("\n");
}

function capability(
  id: string,
  state: CapabilityState,
  access: Capability["access"],
  resource: string,
  backend: string,
  permission: string,
): Capability {
  return { id, state, access, resource, backend, permission };
}
