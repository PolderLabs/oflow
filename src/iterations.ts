import { loadConfig } from "./config.js";
import { OflowError } from "./errors.js";
import { getGitLabRemote } from "./git.js";
import { GitLabApiError, GitLabClient } from "./gitlab.js";
import type { GitLabPagination } from "./gitlab.js";
import { loadProjectGroupContext } from "./group.js";
import type { GitLabIteration, IterationState } from "./types.js";

export type IterationScope = "project" | "group";

export interface IterationSummary {
  iid: number;
  title: string | null;
  state: string | null;
  startDate: string | null;
  dueDate: string | null;
  webUrl: string | null;
}

export interface IterationListResult {
  scope: IterationScope;
  projectPath: string;
  groupPath: string | null;
  state: IterationState;
  iterations: IterationSummary[];
  pagination: GitLabPagination;
}

export async function listIterations(
  root: string,
  state: IterationState,
  limit: number,
  scope: IterationScope = "project",
): Promise<IterationListResult> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }

  const remote = await getGitLabRemote(root);
  let page;
  let groupPath: string | null = null;
  if (scope === "group") {
    const context = await loadProjectGroupContext(root);
    try {
      page = await context.client.listGroupIterationsPage(context.groupPath, state, limit);
    } catch (error: unknown) {
      if (error instanceof GitLabApiError &&
        [401, 403, 404].includes(error.status)) {
        throw new OflowError(
          "Could not read parent-group iterations for " + context.groupPath + ". Check Group: Read access, confirm iterations are available on this GitLab tier/version, or use the default project-visible iteration view.",
          "GITLAB_GROUP_UNAVAILABLE",
        );
      }
      throw error;
    }
    groupPath = context.groupPath;
  } else {
    page = await new GitLabClient(remote.host)
      .listProjectIterationsPage(remote.projectPath, state, limit);
  }

  return {
    scope,
    projectPath: remote.projectPath,
    groupPath,
    state,
    iterations: page.items.map(compactIteration),
    pagination: page.pagination,
  };
}

export function formatIterationListMarkdown(result: IterationListResult): string {
  const lines = [
    "# oflow iteration",
    "",
    "Scope: " + (result.scope === "group" ? "parent group" : "project-visible"),
    "Project: " + result.projectPath,
    ...(result.groupPath ? ["Group: " + result.groupPath] : []),
    "State: " + result.state,
    "Count: " + String(result.iterations.length) +
      (result.pagination.hasNextPage ? " (more may exist)" : ""),
    "",
  ];
  if (result.iterations.length === 0) {
    lines.push("_No iterations found._");
  } else {
    lines.push(...result.iterations.map(formatIteration));
  }
  lines.push(
    "",
    "Use `oflow sync --summary --json` for the token-light combined snapshot; use `oflow sync --json` when full bounded collections are needed.",
    "",
  );
  return lines.join("\n");
}

function compactIteration(iteration: GitLabIteration): IterationSummary {
  return {
    iid: iteration.iid,
    title: iteration.title ? oneLine(iteration.title) : null,
    state: iteration.state ?? null,
    startDate: iteration.start_date ?? null,
    dueDate: iteration.due_date ?? null,
    webUrl: iteration.web_url ?? null,
  };
}

function formatIteration(iteration: IterationSummary): string {
  const title = iteration.title ?? "(untitled iteration)";
  const dates = [iteration.startDate, iteration.dueDate].every(Boolean)
    ? " " + iteration.startDate + ".." + iteration.dueDate
    : "";
  const label = "#" + String(iteration.iid) + " " + title;
  return "- " + (iteration.webUrl ? "[" + label + "](" + iteration.webUrl + ")" : label) +
    " (" + (iteration.state ?? "unknown") + dates + ")";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
