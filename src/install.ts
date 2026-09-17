import { join, resolve } from "node:path";
import { detectAgents } from "./agents.js";
import { makeConfig } from "./config.js";
import {
  ensureLines,
  readText,
  upsertManagedBlock,
  writeJson,
  writeText,
} from "./fs.js";
import { getGitLabRemote } from "./git.js";
import {
  agentInstructionBlock,
  CACHE_POLICY_MARKDOWN,
  CACHE_POLICY_MARKER,
  COPILOT_INSTRUCTIONS_MARKDOWN,
  MERGE_REQUEST_TEMPLATE_MARKDOWN,
  OFLOW_README_MARKDOWN,
  WORKFLOW_MARKDOWN,
  WORKFLOW_MARKER,
} from "./templates.js";
import type {
  AgentDetection,
  FileAction,
  InstallFileChange,
  InstallResult,
  OflowConfig,
} from "./types.js";

export interface InstallOptions {
  root: string;
  agentMode?: string;
  dryRun?: boolean;
}

export async function installProject(options: InstallOptions): Promise<InstallResult> {
  const root = resolve(options.root);
  const dryRun = options.dryRun ?? false;
  const remote = await getGitLabRemote(root);
  const detection = await detectAgents(root, options.agentMode ?? process.env.OFLOW_AGENT);
  const warnings: string[] = [];
  const files: InstallFileChange[] = [];

  const installBoth = detection.mode === "unknown";
  if (installBoth) {
    warnings.push("No Claude or Codex signal was detected; installing both instruction files.");
  }

  files.push(
    await planConfig(root, remote, detection, dryRun, warnings),
    await planWorkflowFile(root, dryRun),
    await planCanonicalFile(root, ".oflow/README.md", OFLOW_README_MARKDOWN, dryRun),
    await planCanonicalFile(
      root,
      ".oflow/templates/merge-request.md",
      MERGE_REQUEST_TEMPLATE_MARKDOWN,
      dryRun,
    ),
    await planCanonicalFile(
      root,
      ".github/copilot-instructions.md",
      COPILOT_INSTRUCTIONS_MARKDOWN,
      dryRun,
    ),
  );

  if (detection.codex || installBoth) {
    files.push({
      path: "AGENTS.md",
      action: await upsertManagedBlock(
        join(root, "AGENTS.md"),
        WORKFLOW_MARKER,
        agentInstructionBlock("codex"),
        dryRun,
      ),
      detail: "Codex project instructions",
    });
  }
  if (detection.claude || installBoth) {
    files.push({
      path: "CLAUDE.md",
      action: await upsertManagedBlock(
        join(root, "CLAUDE.md"),
        WORKFLOW_MARKER,
        agentInstructionBlock("claude"),
        dryRun,
      ),
      detail: "Claude project instructions",
    });
  }

  files.push({
    path: ".gitignore",
    action: await ensureLines(
      join(root, ".gitignore"),
      [".oflow/state/", ".oflow/context/", ".oflow/cache/"],
      dryRun,
    ),
    detail: "local oflow state and cache",
  });

  return { root, remote, detection, files, warnings };
}

export function formatInstallResult(result: InstallResult): string {
  const lines = [
    "# oflow install",
    "",
    "Project: " + result.remote.projectPath,
    "GitLab host: " + result.remote.host,
    "Detected agents: " + result.detection.mode,
    "",
    "Files:",
    ...result.files.map(
      (file) => "- " + file.action + " " + file.path + " (" + file.detail + ")",
    ),
  ];
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => "- " + warning));
  }
  return lines.join("\n") + "\n";
}

async function planCanonicalFile(
  root: string,
  relativePath: string,
  content: string,
  dryRun: boolean,
): Promise<InstallFileChange> {
  const path = join(root, relativePath);
  const current = await readText(path);
  if (current !== null) {
    return {
      path: relativePath,
      action: "unchanged",
      detail: "existing file preserved",
    };
  }
  if (!dryRun) {
    await writeText(path, content + "\n");
  }
  return { path: relativePath, action: "created", detail: "oflow scaffold" };
}

async function planWorkflowFile(root: string, dryRun: boolean): Promise<InstallFileChange> {
  const path = join(root, ".oflow/WORKFLOW.md");
  const current = await readText(path);
  if (current === null) {
    if (!dryRun) {
      await writeText(path, WORKFLOW_MARKDOWN + "\n");
    }
    return { path: ".oflow/WORKFLOW.md", action: "created", detail: "oflow workflow contract" };
  }

  const action = await upsertManagedBlock(
    path,
    CACHE_POLICY_MARKER,
    CACHE_POLICY_MARKDOWN,
    dryRun,
  );
  return {
    path: ".oflow/WORKFLOW.md",
    action,
    detail: action === "unchanged"
      ? "existing workflow preserved"
      : "mandatory cache policy refreshed; existing workflow preserved",
  };
}

async function planConfig(
  root: string,
  remote: InstallResult["remote"],
  detection: AgentDetection,
  dryRun: boolean,
  warnings: string[],
): Promise<InstallFileChange> {
  const relativePath = ".oflow/config.json";
  const path = join(root, relativePath);
  const desired = makeConfig(remote, detection);
  const currentText = await readText(path);
  if (currentText === null) {
    if (!dryRun) {
      await writeJson(path, desired);
    }
    return { path: relativePath, action: "created", detail: "oflow configuration" };
  }

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(currentText);
    if (!isRecord(value)) {
      throw new Error("configuration must be a JSON object");
    }
    parsed = value;
  } catch (error: unknown) {
    warnings.push("Existing .oflow/config.json is not valid oflow JSON; it was preserved.");
    return { path: relativePath, action: "skipped", detail: "invalid existing configuration" };
  }

  if (parsed.managedBy !== "oflow") {
    warnings.push("Existing .oflow/config.json is not managed by oflow; it was preserved.");
    return { path: relativePath, action: "skipped", detail: "different configuration owner" };
  }

  const existingWorkflow = isRecord(parsed.workflow) ? parsed.workflow : {};
  const next: OflowConfig = {
    ...desired,
    ...parsed,
    managedBy: "oflow",
    version: 1,
    project: desired.project,
    agent: desired.agent,
    workflow: {
      ...desired.workflow,
      ...existingWorkflow,
    } as OflowConfig["workflow"],
  };
  const nextText = JSON.stringify(next, null, 2) + "\n";
  if (nextText === currentText) {
    return { path: relativePath, action: "unchanged", detail: "configuration already current" };
  }
  if (!dryRun) {
    await writeText(path, nextText);
  }
  return { path: relativePath, action: "updated", detail: "remote and detected agent refreshed" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
