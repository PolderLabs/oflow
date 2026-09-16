import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { OflowError } from "./errors.js";
import type { GitLabRemote } from "./types.js";

const execFile = promisify(execFileCallback);

export async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const result = await execFile("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OflowError("git " + args.join(" ") + " failed: " + message, "GIT_ERROR");
  }
}

export async function getRepoRoot(start: string): Promise<string> {
  return runGit(["rev-parse", "--show-toplevel"], start);
}

export async function getCurrentBranch(root: string): Promise<string | null> {
  try {
    const branch = await runGit(["branch", "--show-current"], root);
    return branch || null;
  } catch {
    return null;
  }
}

export function parseGitRemote(remoteUrl: string): GitLabRemote {
  const value = remoteUrl.trim();
  let host: string;
  let projectPath: string;

  const scpLike = value.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scpLike && !value.includes("://")) {
    const atIndex = value.indexOf("@");
    const colonIndex = value.indexOf(":");
    if (atIndex >= 0 && colonIndex < atIndex) {
      throw new OflowError(
        "Git remote URL contains embedded credentials. Remove them and use Git credentials or GITLAB_TOKEN.",
        "EMBEDDED_REMOTE_CREDENTIALS",
      );
    }
    host = scpLike[1];
    projectPath = scpLike[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new OflowError("Unsupported git remote URL.", "INVALID_REMOTE");
    }
    if (parsed.username || parsed.password) {
      throw new OflowError(
        "Git remote URL contains embedded credentials. Remove them and use Git credentials or GITLAB_TOKEN.",
        "EMBEDDED_REMOTE_CREDENTIALS",
      );
    }
    host = parsed.host;
    projectPath = parsed.pathname;
  }

  projectPath = projectPath.replace(/^\/+/, "").replace(/\.git$/, "");
  if (!host || projectPath.split("/").filter(Boolean).length < 2) {
    throw new OflowError("Git remote does not contain a GitLab project path.", "INVALID_REMOTE");
  }

  return {
    host: host.toLowerCase(),
    projectPath,
    remoteUrl: value,
  };
}

export async function getGitLabRemote(root: string): Promise<GitLabRemote> {
  const remote = await runGit(["remote", "get-url", "origin"], root);
  const parsed = parseGitRemote(remote);
  if (
    /(^|\.)github\.com$/i.test(parsed.host) ||
    /(^|\.)bitbucket\.org$/i.test(parsed.host)
  ) {
    throw new OflowError(
      "The origin points to " +
        parsed.host +
        ", not GitLab. Run this command inside the GitLab checkout.",
      "NOT_GITLAB",
    );
  }
  return parsed;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
