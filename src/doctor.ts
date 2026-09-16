import { join } from "node:path";
import { detectAgents } from "./agents.js";
import { configPath, loadConfig } from "./config.js";
import { exists } from "./fs.js";
import { getGitLabRemote } from "./git.js";
import { getGitLabToken, getGitLabTokenSource } from "./auth.js";
import { GitLabClient } from "./gitlab.js";
import type { DoctorReport, GitLabRemote } from "./types.js";

export interface DoctorOptions {
  checkApi?: boolean;
}

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
    warnings.push("No Claude or Codex signal was detected.");
  }
  for (const file of requiredFiles) {
    if (!file.present) {
      warnings.push("Missing " + file.path + ".");
    }
  }

  let apiCheck: DoctorReport["apiCheck"] = "not-requested";
  if (options.checkApi) {
    if (remote && tokenSource) {
      try {
        await new GitLabClient(remote.host).getProject(remote.projectPath);
        apiCheck = "passed";
      } catch (error: unknown) {
        apiCheck = "failed";
        warnings.push(
          "GitLab API check failed: " +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    } else if (remote) {
      warnings.push("GitLab API check skipped because no token is configured.");
    }
  }

  return {
    root,
    remote,
    configFound: await exists(configPath(root)),
    agent,
    tokenConfigured: Boolean(tokenSource),
    tokenSource: tokenSource?.kind ?? null,
    apiCheck,
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
    "GitLab token: " +
      (report.tokenConfigured
        ? "configured (" + report.tokenSource + ")"
        : "missing"),
    "GitLab API check: " + report.apiCheck,
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
