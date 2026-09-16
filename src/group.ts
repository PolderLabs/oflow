import { loadConfig } from "./config.js";
import { OflowError } from "./errors.js";
import { getGitLabRemote } from "./git.js";
import { GitLabClient } from "./gitlab.js";
import type { GitLabProject } from "./types.js";

export interface ProjectGroupContext {
  client: GitLabClient;
  groupPath: string;
}

export async function loadProjectGroupContext(
  root: string,
): Promise<ProjectGroupContext> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const project = await client.getProject(remote.projectPath);
  const groupPath = projectNamespacePath(project) ?? parentGroupPath(remote.projectPath);
  if (!groupPath) {
    throw new OflowError(
      "Could not determine the GitLab parent group for this project.",
      "MISSING_GITLAB_GROUP",
    );
  }
  return { client, groupPath };
}

function projectNamespacePath(project: GitLabProject): string | null {
  const fullPath = project.namespace?.full_path;
  return typeof fullPath === "string" && fullPath.trim() ? fullPath : null;
}

function parentGroupPath(projectPath: string): string | null {
  const separator = projectPath.lastIndexOf("/");
  return separator > 0 ? projectPath.slice(0, separator) : null;
}
