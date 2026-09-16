import { loadConfig } from "./config.js";
import { getGitLabRemote } from "./git.js";
import { GitLabClient } from "./gitlab.js";
import { OflowError } from "./errors.js";
import type {
  GitLabGroupEpic,
  GitLabWorkItemReference,
  GitLabProject,
} from "./types.js";

export interface GroupEpicList {
  groupPath: string;
  epics: GitLabGroupEpic[];
  mayBeTruncated: boolean;
}

export interface GroupEpicDisplay extends GitLabGroupEpic {
  parent: GitLabWorkItemReference | null;
  children: GitLabWorkItemReference[];
}

export async function listProjectGroupEpics(
  root: string,
  limit: number,
): Promise<GroupEpicList> {
  const clientContext = await loadProjectGroupContext(root);
  const result = await clientContext.client.listGroupEpics(clientContext.groupPath, limit);
  return { groupPath: clientContext.groupPath, ...result };
}

export async function loadProjectGroupEpic(
  root: string,
  iid: number,
): Promise<{ groupPath: string; epic: GroupEpicDisplay }> {
  const clientContext = await loadProjectGroupContext(root);
  const epic = await clientContext.client.getGroupEpic(clientContext.groupPath, iid);
  return { groupPath: clientContext.groupPath, epic };
}

export function formatGroupEpicListMarkdown(result: GroupEpicList): string {
  const lines = [
    "# oflow epic",
    "",
    "Group: " + result.groupPath,
    "Count: " + String(result.epics.length) +
      (result.mayBeTruncated ? " (more may exist)" : ""),
    "",
  ];
  if (result.epics.length === 0) {
    lines.push("_No group epics found._");
  } else {
    lines.push(
      ...result.epics.map(
        (epic) =>
          "- &" + String(epic.iid) + " " + linkOrText(epic.title, epic.web_url) +
          " (" + (epic.state ?? "unknown") + ")",
      ),
    );
  }
  lines.push(
    "",
    "Use `oflow epic --iid <iid>` for parent and child work items.",
    "",
  );
  return lines.join("\n");
}

export function formatGroupEpicMarkdown(result: {
  groupPath: string;
  epic: GroupEpicDisplay;
}): string {
  const { epic } = result;
  const lines = [
    "# oflow epic",
    "",
    "Epic &" + String(epic.iid) + ": " + linkOrText(epic.title, epic.web_url),
    "Group: " + result.groupPath,
    "State: " + (epic.state ?? "unknown"),
    "Parent: " + (epic.parent ? formatReference(epic.parent) : "none"),
    "Children: " + (epic.children.length > 0
      ? epic.children.map(formatReference).join(", ")
      : "none"),
    "",
  ];
  return lines.join("\n");
}

async function loadProjectGroupContext(root: string): Promise<{
  client: GitLabClient;
  groupPath: string;
}> {
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

function formatReference(reference: GitLabWorkItemReference): string {
  const prefix = reference.type?.toLowerCase() === "epic" ? "&" : "#";
  return (reference.iid === null ? "work item" : prefix + String(reference.iid)) +
    " " + linkOrText(reference.title, reference.web_url);
}

function linkOrText(value: string, url: string | null): string {
  return url ? "[" + value + "](" + url + ")" : value;
}
