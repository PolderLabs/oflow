import { join } from "node:path";
import { detectAgents } from "./agents.js";
import { configPath, loadConfig } from "./config.js";
import { exists } from "./fs.js";
import { getGitLabRemote } from "./git.js";
import { getGitLabToken } from "./gitlab.js";
import type { DoctorReport, GitLabRemote } from "./types.js";

export async function doctor(root: string): Promise<DoctorReport> {
  const warnings: string[] = [];
  let remote: GitLabRemote | null = null;
  try {
    remote = await getGitLabRemote(root);
  } catch (error: unknown) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  const config = await loadConfig(root);
  const agent = await detectAgents(root);
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
  if (!getGitLabToken()) {
    warnings.push("GITLAB_TOKEN is not configured; API-backed commands cannot run.");
  }
  if (agent.mode === "unknown") {
    warnings.push("No Claude or Codex signal was detected.");
  }
  for (const file of requiredFiles) {
    if (!file.present) {
      warnings.push("Missing " + file.path + ".");
    }
  }

  return {
    root,
    remote,
    configFound: await exists(configPath(root)),
    agent,
    tokenConfigured: Boolean(getGitLabToken()),
    requiredFiles,
    warnings,
  };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [
    "# oflow doctor",
    "",
    "Repository: " + report.root,
    "GitLab remote: " + (report.remote ? report.remote.projectPath : "not detected"),
    "oflow config: " + (report.configFound ? "present" : "missing"),
    "Detected agents: " + report.agent.mode,
    "GitLab token: " + (report.tokenConfigured ? "configured" : "missing"),
    "",
    "Required files:",
    ...report.requiredFiles.map(
      (file) => "- " + (file.present ? "present" : "missing") + " " + file.path,
    ),
  ];
  if (report.warnings.length > 0) {
    lines.push("", "Warnings:", ...report.warnings.map((warning) => "- " + warning));
  } else {
    lines.push("", "No warnings.");
  }
  return lines.join("\n") + "\n";
}
