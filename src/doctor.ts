import { join } from "node:path";
import { detectAgents } from "./agents.js";
import { configPath, loadConfig } from "./config.js";
import { exists } from "./fs.js";
import { getGitLabRemote } from "./git.js";
import { getGitLabToken, getGitLabTokenSource } from "./auth.js";
import { normalizeForbidden, resolveAuth } from "./auth-resolver.js";
import { deriveTransportState, type TransportState } from "./transport.js";
import { GitLabClient } from "./gitlab.js";
import { detectBackends } from "./backends.js";
import { dim, statusMarker, type PresentationOptions } from "./presentation.js";
import type {
  AuthCapability,
  DoctorCapabilityCheck,
  DoctorReport,
  DoctorCheckStatus,
  GitLabProject,
  GitLabRemote,
} from "./types.js";

export interface DoctorOptions {
  checkApi?: boolean;
}

interface ProbeResult<T> {
  check: DoctorCapabilityCheck;
  value: T | null;
}

const READ_CHECKS: Array<{
  id: string;
  backend: DoctorCapabilityCheck["backend"];
  required: boolean;
}> = [
  { id: "project.read", backend: "REST", required: true },
  { id: "user.read", backend: "REST", required: true },
  { id: "work-items.read", backend: "REST", required: true },
  { id: "merge-requests.read", backend: "REST", required: true },
  { id: "pipelines.read", backend: "REST", required: true },
  { id: "labels.read", backend: "REST", required: true },
  { id: "milestones.read", backend: "REST", required: true },
  { id: "boards.read", backend: "REST", required: true },
  { id: "board-lists.read", backend: "REST", required: true },
  { id: "iterations.read", backend: "REST", required: true },
  { id: "group-epics.read", backend: "GraphQL", required: false },
  { id: "group-iterations.read", backend: "REST", required: false },
  { id: "iteration-cadences.read", backend: "GraphQL", required: false },
];

const GUARDED_WRITE_CHECKS: Array<{
  id: string;
  backend: DoctorCapabilityCheck["backend"];
  required: boolean;
  detail: string;
}> = [
  {
    id: "work-items.create",
    backend: "REST",
    required: true,
    detail: "Not probed: doctor never creates or mutates a remote work item.",
  },
  {
    id: "work-items.update",
    backend: "REST",
    required: true,
    detail: "Not probed: doctor never updates a remote work item.",
  },
  {
    id: "notes.write",
    backend: "REST",
    required: true,
    detail: "Not probed: doctor never creates a remote note.",
  },
  {
    id: "labels.write",
    backend: "REST",
    required: true,
    detail: "Not probed: doctor never creates or updates a remote label.",
  },
  {
    id: "milestones.write",
    backend: "REST",
    required: true,
    detail: "Not probed: doctor never creates or updates a remote milestone.",
  },
  {
    id: "boards.write",
    backend: "REST",
    required: true,
    detail: "Not probed: doctor never creates or updates a remote board/list.",
  },
  {
    id: "iteration-assignment.write",
    backend: "GraphQL",
    required: true,
    detail: "Not probed: doctor never runs the IssueSetIteration mutation.",
  },
  {
    id: "work-items.bulk-iteration.update",
    backend: "GraphQL",
    required: true,
    detail: "Not probed: doctor never runs a bulk iteration mutation.",
  },
  {
    id: "merge-requests.write",
    backend: "REST + GraphQL",
    required: false,
    detail: "Planned only; oflow has no merge-request apply path yet.",
  },
];

export async function doctor(
  root: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const warnings: string[] = [];
  let remote: GitLabRemote | null = null;
  try {
    remote = await getGitLabRemote(root);
  } catch (error: unknown) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  const config = await loadConfig(root);
  const agent = await detectAgents(root);
  const backends = await detectBackends();
  const requiredPaths = [
    ".oflow/config.json",
    ".oflow/WORKFLOW.md",
    ".oflow/README.md",
    ".oflow/templates/merge-request.md",
  ];
  const requiredFiles = await Promise.all(
    requiredPaths.map(async (path) => ({ path, present: await exists(join(root, path)) })),
  );

  if (!config) {
    warnings.push("oflow is not installed in this repository.");
  }
  const tokenSource = getGitLabTokenSource(remote?.host);
  if (!getGitLabToken(remote?.host)) {
    warnings.push(
      "No GitLab token is configured; run oflow auth login or set GITLAB_TOKEN.",
    );
  }
  if (agent.mode === "unknown") {
    warnings.push("No Claude, Codex, or OMP signal was detected.");
  }
  for (const file of requiredFiles) {
    if (!file.present) {
      warnings.push("Missing " + file.path + ".");
    }
  }

  let apiCheck: DoctorReport["apiCheck"] = options.checkApi
    ? "skipped"
    : "not-requested";
  let apiChecks: DoctorCapabilityCheck[] = [];
  if (options.checkApi) {
    if (remote && tokenSource) {
      apiChecks = await checkApiCapabilities(remote, backends);
      const failedRequiredChecks = apiChecks.filter(
        (check) => check.required && check.status === "failed",
      );
      apiCheck = failedRequiredChecks.length === 0 ? "passed" : "failed";
      for (const check of failedRequiredChecks) {
        warnings.push(
          "GitLab " + check.backend + " " + check.id + " check failed: " + check.detail,
        );
      }
    } else if (remote) {
      warnings.push("GitLab API check skipped because no token is configured.");
      apiChecks = skippedApiChecks(
        "No token configured; authenticate before probing GitLab.",
        backends,
      );
    }
  }
  let capabilities: AuthCapability[] | undefined;
  let transport: DoctorReport["transport"];
  if (options.checkApi) {
    let authSource: string | undefined;
    let mcpPresent = false;
    let transportState: TransportState | undefined;
    if (remote) {
      try {
        const resolution = await resolveAuth({ host: remote.host, root });
        authSource = resolution.sources[0]?.source;
        mcpPresent = resolution.sources.some((source) => source.source === "mcp-runtime");
        transportState = deriveTransportState(resolution);
        transport = {
          host: resolution.host,
          state: transportState,
          reduced:
            transportState.readable !== true ||
            transportState.mutable === "unsupported",
        };
      } catch {
        // best-effort only; resolution.sources is informational
      }
    }
    capabilities = apiChecks.map((check) =>
      mapDoctorCheckToAuthCapability(check, authSource, mcpPresent),
    );
  }
  return {
    root,
    remote,
    configFound: await exists(configPath(root)),
    agent,
    tokenConfigured: Boolean(tokenSource),
    tokenSource: tokenSource?.kind ?? null,
    apiCheck,
    apiChecks,
    ...(capabilities ? { capabilities } : {}),
    ...(transport ? { transport } : {}),
    backends,
    requiredFiles,
    warnings,
  };
}

async function checkApiCapabilities(
  remote: GitLabRemote,
  backends: DoctorReport["backends"],
): Promise<DoctorCapabilityCheck[]> {
  const client = new GitLabClient(remote.host);
  const checks: DoctorCapabilityCheck[] = [];
  const projectProbe = await runProbe(
    {
      id: "project.read",
      access: "read",
      backend: "REST",
      required: true,
    },
    () => client.getProject(remote.projectPath),
    "Project metadata is readable.",
  );
  checks.push(projectProbe.check);

  const [userProbe, workItemsProbe, mergeRequestsProbe, pipelinesProbe, labelsProbe, milestonesProbe, boardsProbe, iterationsProbe] =
    await Promise.all([
      runProbe(
        { id: "user.read", access: "read", backend: "REST", required: true },
        () => client.getCurrentUser(),
        "Authenticated user is readable.",
      ),
      runProbe(
        { id: "work-items.read", access: "read", backend: "REST", required: true },
        () => client.listIssuesPage(remote.projectPath, "opened", 1),
        "Work-item collection is readable (bounded to 1 item).",
      ),
      runProbe(
        { id: "merge-requests.read", access: "read", backend: "REST", required: true },
        () => client.listMergeRequestsPage(remote.projectPath, undefined, "opened", 1),
        "Merge-request collection is readable (bounded to 1 item).",
      ),
      runProbe(
        { id: "pipelines.read", access: "read", backend: "REST", required: true },
        () => client.listPipelinesPage(remote.projectPath, null, 1),
        "Pipeline collection is readable (bounded to 1 item).",
      ),
      runProbe(
        { id: "labels.read", access: "read", backend: "REST", required: true },
        () => client.listLabelsPage(remote.projectPath, 1),
        "Label collection is readable (bounded to 1 item).",
      ),
      runProbe(
        { id: "milestones.read", access: "read", backend: "REST", required: true },
        () => client.listMilestonesPage(remote.projectPath, "active", 1),
        "Milestone collection is readable (bounded to 1 item).",
      ),
      runProbe(
        { id: "boards.read", access: "read", backend: "REST", required: true },
        () => client.listBoardsPage(remote.projectPath, 1),
        "Board collection is readable (bounded to 1 board).",
      ),
      runProbe(
        { id: "iterations.read", access: "read", backend: "REST", required: true },
        () => client.listProjectIterationsPage(remote.projectPath, "all", 1),
        "Project-visible iteration collection is readable (bounded to 1 item).",
      ),
    ]);
  checks.push(
    userProbe.check,
    workItemsProbe.check,
    mergeRequestsProbe.check,
    pipelinesProbe.check,
    labelsProbe.check,
    milestonesProbe.check,
    boardsProbe.check,
    iterationsProbe.check,
  );

  if (userProbe.check.status === "passed") {
    const tokenProbe = await runProbe(
      { id: "token.scopes", access: "read", backend: "REST", required: false },
      () => client.getPersonalAccessTokenSelf(),
      "Token scopes reported by the personal access token self endpoint.",
    );
    if (tokenProbe.check.status === "failed" && tokenScopesUnsupported(tokenProbe.check.detail)) {
      checks.push({
        ...tokenProbe.check,
        status: "skipped",
        detail: "Personal access token self endpoint unavailable on this GitLab version or token kind; scopes cannot be reported.",
      });
    } else {
      checks.push(tokenProbe.check.status === "passed" && tokenProbe.value
        ? { ...tokenProbe.check, detail: formatTokenScopes(tokenProbe.value) }
        : tokenProbe.check);
    }
  }

  const firstBoard = boardsProbe.value?.items[0];
  if (boardsProbe.check.status === "passed" && firstBoard && typeof firstBoard.id === "number") {
    const boardListsProbe = await runProbe(
      {
        id: "board-lists.read",
        access: "read",
        backend: "REST",
        required: true,
      },
      () => client.listBoardListsPage(remote.projectPath, firstBoard.id, 1),
      "Board-list collection is readable (bounded to 1 item).",
    );
    checks.push(boardListsProbe.check);
  } else {
    checks.push({
      id: "board-lists.read",
      access: "read",
      backend: "REST",
      status: "skipped",
      required: true,
      detail: "Skipped because the project has no readable board to inspect.",
    });
  }

  const groupPath = inferGroupPath(projectProbe.value, remote.projectPath);
  if (groupPath) {
    const [groupEpicsProbe, groupIterationsProbe, cadenceProbe] = await Promise.all([
      runProbe(
        {
          id: "group-epics.read",
          access: "read",
          backend: "GraphQL",
          required: false,
        },
        () => client.listGroupEpics(groupPath, 1),
        "Group epic collection is readable (bounded to 1 item).",
      ),
      runProbe(
        {
          id: "group-iterations.read",
          access: "read",
          backend: "REST",
          required: false,
        },
        () => client.listGroupIterationsPage(groupPath, "current", 1),
        "Group-visible iteration collection is readable (bounded to 1 item).",
      ),
      runProbe(
        {
          id: "iteration-cadences.read",
          access: "read",
          backend: "GraphQL",
          required: false,
        },
        () => client.listIterationCadences(groupPath, 1),
        "Group iteration-cadence collection is readable (bounded to 1 item).",
      ),
    ]);
    checks.push(groupEpicsProbe.check, groupIterationsProbe.check, cadenceProbe.check);
  } else {
    checks.push(
      skippedCheck(
        "group-epics.read",
        "GraphQL",
        "No parent group could be inferred from the project remote.",
      ),
      skippedCheck(
        "group-iterations.read",
        "REST",
        "No parent group could be inferred from the project remote.",
      ),
      skippedCheck(
        "iteration-cadences.read",
        "GraphQL",
        "No parent group could be inferred from the project remote.",
      ),
    );
  }

  checks.push({
    id: "glab.fallback",
    access: "read",
    backend: "glab",
    status: backends.glab.available ? "passed" : "skipped",
    required: false,
    detail: backends.glab.available
      ? "Executable detected; oflow does not inspect or copy glab credentials."
      : "Optional executable is not installed; REST remains the core backend.",
  });
  checks.push({
    id: "mcp.agent-runtime",
    access: "read",
    backend: "MCP",
    status: "not-probed",
    required: false,
    detail: "MCP belongs to the connected agent runtime and is not inspectable by the CLI.",
  });
  checks.push(...writeChecks());
  return checks;
}

function skippedApiChecks(
  detail: string,
  backends: DoctorReport["backends"],
): DoctorCapabilityCheck[] {
  return [
    ...READ_CHECKS.map((item) => ({
      id: item.id,
      access: "read" as const,
      backend: item.backend,
      status: "skipped" as const,
      required: item.required,
      detail,
    })),
    {
      id: "glab.fallback",
      access: "read",
      backend: "glab",
      status: backends.glab.available ? "passed" : "skipped",
      required: false,
      detail: backends.glab.available
        ? "Executable detected; no GitLab request made by oflow."
        : "Optional executable is not installed.",
    },
    {
      id: "mcp.agent-runtime",
      access: "read",
      backend: "MCP",
      status: "not-probed",
      required: false,
      detail: "MCP belongs to the connected agent runtime and is not inspectable by the CLI.",
    },
    ...writeChecks(),
  ];
}

function writeChecks(): DoctorCapabilityCheck[] {
  return GUARDED_WRITE_CHECKS.map((item) => ({
    id: item.id,
    access: "write",
    backend: item.backend,
    status: "not-probed",
    required: item.required,
    detail: item.detail + " Use plan -> approve -> apply -> verify for a real change.",
  }));
}

async function runProbe<T>(
  definition: Pick<DoctorCapabilityCheck, "id" | "access" | "backend" | "required">,
  operation: () => Promise<T>,
  successDetail: string,
): Promise<ProbeResult<T>> {
  const startedAt = performance.now();
  try {
    const value = await operation();
    return {
      check: { ...definition, status: "passed", detail: successDetail, latencyMs: Math.round(performance.now() - startedAt) },
      value,
    };
  } catch (error: unknown) {
    return {
      check: {
        ...definition,
        status: "failed",
        detail: formatProbeError(error),
        latencyMs: Math.round(performance.now() - startedAt),
      },
      value: null,
    };
  }
}

function formatTokenScopes(
  token: { scopes: string[]; expiresAt: string | null; revoked: boolean; active: boolean },
): string {
  const scopes = token.scopes.length > 0 ? token.scopes.join(", ") : "none reported";
  const state = token.revoked
    ? "revoked"
    : token.active
      ? "active"
      : "inactive";
  return "Token " + state + " with scopes: " + scopes +
    (token.expiresAt ? " (expires " + token.expiresAt + ")" : "") + ".";
}

function tokenScopesUnsupported(detail: string): boolean {
  return /GitLab API (403|404)/.test(detail);
}

function skippedCheck(
  id: string,
  backend: DoctorCapabilityCheck["backend"],
  detail: string,
): DoctorCapabilityCheck {
  return {
    id,
    access: "read",
    backend,
    status: "skipped",
    required: false,
    detail,
  };
}

function mapDoctorCheckToAuthCapability(
  check: DoctorCapabilityCheck,
  source: string | undefined,
  mcpRuntimePresent: boolean,
): AuthCapability {
  const probe: AuthCapability["probe"] =
    check.status === "passed"
      ? "passed"
      : check.status === "skipped"
        ? "skipped"
        : check.status === "not-probed"
          ? "not-probed"
          : "failed";
  // Writes are only "usable" when the MCP runtime owns the OAuth session
  // (same rule as auth-resolver): doctor never runs a write probe.
  const usable =
    probe === "passed" ||
    (check.access === "write" && probe === "not-probed" && mcpRuntimePresent);
  const backend: AuthCapability["backend"] =
    check.backend === "MCP"
      ? "gitlab-mcp"
      : check.backend === "glab"
        ? "glab"
        : check.backend === "GraphQL"
          ? "graphql"
          : check.backend === "REST + GraphQL"
            ? "rest"
            : "rest";
  const mcpWrite = check.access === "write" && mcpRuntimePresent;
  return {
    id: check.id,
    usable,
    probe,
    backend: mcpWrite ? "gitlab-mcp" : backend,
    ...(mcpWrite ? { source: "mcp-runtime" } : source ? { source } : {}),
    reason: check.detail,
  };
}

function formatProbeError(error: unknown): string {
  const { reason, remediation } = normalizeForbidden(error);
  return remediation ? reason + " — remediation: " + remediation : reason;
}
function inferGroupPath(project: GitLabProject | null, projectPath: string): string | null {

  const namespace = project?.namespace;
  if (namespace && typeof namespace.full_path === "string" && namespace.full_path.trim()) {
    return namespace.full_path;
  }
  const parts = projectPath.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : null;
}

export function formatDoctor(report: DoctorReport, presentation: PresentationOptions = { color: false }): string {
  const lines = [
    dim("# oflow doctor", presentation),
    "",
    "Repository: " + report.root,
    "GitLab remote: " + (report.remote ? report.remote.projectPath : "not detected"),
    "oflow config: " + (report.configFound ? "present" : "missing"),
    "Detected agents: " + report.agent.mode,
    "GitLab token: " +
      (report.tokenConfigured
        ? "configured (" + report.tokenSource + ")"
        : "missing"),
    "GitLab API check: " + report.apiCheck,
    "",
    "Backends:",
    "- REST: available (core)",
    "- glab: " +
      (report.backends.glab.available
        ? "available" +
          (report.backends.glab.version ? " (" + report.backends.glab.version + ")" : "") +
          " (optional fallback)"
        : "not installed (optional fallback)"),
    "- MCP: agent-runtime optional (reported by the connected agent, not the CLI)",
  ];
  if (report.apiChecks.length > 0) {
    lines.push(
      "",
      "API capability checks (read probes only; no remote writes):",
      ...report.apiChecks
        .filter((check) => check.access === "read")
        .map((check) => formatCapabilityCheck(check, presentation)),
      "",
      "Write capability checks:",
      ...report.apiChecks
        .filter((check) => check.access === "write")
        .map((check) => formatCapabilityCheck(check, presentation)),
      "",
      "Write check policy: doctor never tests a mutation. Use an approved plan and verify the result.",
    );
  }
  if (report.capabilities && report.capabilities.length > 0) {
    lines.push(
      "",
      "Capability usability (F2, probe-based):",
      ...report.capabilities.map((cap) => "- " + formatAuthCapability(cap, presentation)),
    );
  }
  lines.push(
    "",
    "Required files:",
    ...report.requiredFiles.map(
      (file) => "- " + (file.present ? "present" : "missing") + " " + file.path,
    ),
  );
  if (report.warnings.length > 0) {
    lines.push("", "Warnings:", ...report.warnings.map((warning) => "- " + warning));
  } else {
    lines.push("", "No warnings.");
  }
  return lines.join("\n") + "\n";
}

function formatCapabilityCheck(check: DoctorCapabilityCheck, presentation: PresentationOptions): string {
  const marker: Record<DoctorCheckStatus, string> = {
    passed: "PASS",
    failed: "FAIL",
    skipped: "SKIP",
    "not-probed": "N/A",
  };
  return "- [" + statusMarker(marker[check.status], presentation) + "] " +
    check.backend + " " + check.id +
    (check.latencyMs === undefined ? "" : dim(" (" + String(check.latencyMs) + "ms)", presentation)) +
    " — " + check.detail;
}

function formatAuthCapability(cap: AuthCapability, presentation: PresentationOptions): string {
  const marker = cap.usable ? "USABLE" : "BLOCKED";
  const remediation = cap.remediation ? " — remediation: " + cap.remediation : "";
  return "[" + statusMarker(marker, presentation) + "] " +
    cap.id + " via " + cap.backend +
    (cap.source ? " (" + cap.source + ")" : "") +
    " — probe=" + cap.probe +
    (cap.reason ? "; " + cap.reason : "") +
    remediation;
}
