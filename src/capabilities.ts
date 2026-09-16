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
        "Work items, labels, milestones, boards, iterations",
        "REST",
        "Project: Read; Group: Read; Work Item: Read",
      ),
      capability(
        "work-items.update",
        "implemented",
        "apply",
        "Work Item",
        "REST",
        "Work Item: Update",
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
        "planned",
        "plan-only",
        "Board and board list",
        "REST or glab",
        "Work Item: Update",
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
