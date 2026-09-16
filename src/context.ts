import { getCurrentBranch, getGitLabRemote } from "./git.js";
import { loadConfig } from "./config.js";
import { parseAcceptanceCriteria } from "./criteria.js";
import { GitLabClient } from "./gitlab.js";
import { OflowError } from "./errors.js";
import type {
  GitLabIssue,
  GitLabMergeRequest,
  GitLabNote,
  GitLabPipeline,
  IssueState,
  StoryContext,
} from "./types.js";

export async function listWorkItems(
  root: string,
  state: IssueState = "opened",
): Promise<GitLabIssue[]> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }

  const remote = await getGitLabRemote(root);
  return new GitLabClient(remote.host).listIssues(remote.projectPath, state);
}

export function formatWorkItemsMarkdown(
  issues: GitLabIssue[],
  state: IssueState,
): string {
  const lines = [
    "# oflow work",
    "",
    "State: " + state,
    "Count: " + issues.length,
    "",
  ];
  if (issues.length === 0) {
    lines.push("_No work items found._");
  } else {
    lines.push(
      ...issues.map((issue) => {
        const title = issue.web_url
          ? "[" + oneLine(issue.title) + "](" + issue.web_url + ")"
          : oneLine(issue.title);
        const labels = issue.labels && issue.labels.length > 0
          ? " · " + issue.labels.join(", ")
          : "";
        return "- #" + issue.iid + " " + title + labels;
      }),
    );
  }
  lines.push(
    "",
    "Use oflow context --story <iid> for a complete story context.",
    "",
  );
  return lines.join("\n");
}

export async function loadStoryContext(
  root: string,
  storyIid: number,
): Promise<StoryContext> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }

  const remote = await getGitLabRemote(root);
  const warnings: string[] = [];
  if (
    config.project.host !== remote.host ||
    config.project.path !== remote.projectPath
  ) {
    warnings.push(
      "The current Git remote differs from .oflow/config.json; using the current remote.",
    );
  }

  const client = new GitLabClient(remote.host);
  const [project, story] = await Promise.all([
    client.getProject(remote.projectPath),
    client.getIssue(remote.projectPath, storyIid),
  ]);
  const branch = await getCurrentBranch(root);

  const [recentNotes, mergeRequests, pipelines] = await Promise.all([
    optionalFetch<GitLabNote[]>(
      () => client.getIssueNotes(remote.projectPath, storyIid),
      "Could not read story notes",
      warnings,
    ),
    optionalFetch<GitLabMergeRequest[]>(
      () => client.listRelatedMergeRequests(remote.projectPath, storyIid),
      "Could not read related merge requests",
      warnings,
    ),
    optionalFetch<GitLabPipeline[]>(
      () => client.listPipelines(remote.projectPath, branch),
      "Could not read pipelines",
      warnings,
    ),
  ]);

  const criteria = parseAcceptanceCriteria(story.description);
  const epic = normalizeEpic(story);
  if (criteria.length === 0) {
    warnings.push("Story has no Acceptance criteria checklist.");
  }
  if (mergeRequests.length === 0) {
    warnings.push("No merge request references this story yet.");
  }
  if (pipelines.length === 0) {
    warnings.push("No pipeline was found for the current branch.");
  }

  return {
    generatedAt: new Date().toISOString(),
    branch,
    project,
    story: {
      ...story,
      web_url:
        story.web_url ??
        project.web_url + "/-/issues/" + String(storyIid),
    },
    epic,
    criteria,
    mergeRequests,
    pipelines,
    recentNotes: recentNotes.slice(0, 20),
    warnings,
  };
}

export function formatContextMarkdown(context: StoryContext): string {
  const storyUrl = context.story.web_url
    ? "[" + context.story.title + "](" + context.story.web_url + ")"
    : context.story.title;
  const lines = [
    "# oflow context",
    "",
    "Generated: " + context.generatedAt,
    "Project: [" +
      context.project.path_with_namespace +
      "](" +
      context.project.web_url +
      ")",
    "Branch: " + (context.branch ?? "detached/unknown"),
    "",
    "## Story #" + context.story.iid,
    "",
    storyUrl,
    "",
    "State: " + (context.story.state ?? "unknown"),
    "",
    context.story.description?.trim() || "_No description._",
    "",
    "## Epic / parent",
    "",
    formatParent(context.epic),
    "",
    "## Acceptance criteria",
    "",
  ];

  if (context.criteria.length === 0) {
    lines.push("_No acceptance criteria found._");
  } else {
    lines.push(
      ...context.criteria.map(
        (criterion) =>
          "- [" +
          (criterion.checked ? "x" : " ") +
          "] " +
          criterion.id +
          ": " +
          criterion.text,
      ),
    );
  }

  lines.push("", "## Related merge requests", "");
  if (context.mergeRequests.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push(
      ...context.mergeRequests.map(
        (mergeRequest) =>
          "- ! " +
          mergeRequest.iid +
          " " +
          (mergeRequest.web_url
            ? "[" + mergeRequest.title + "](" + mergeRequest.web_url + ")"
            : mergeRequest.title) +
          " (" +
          (mergeRequest.state ?? "unknown") +
          ")",
      ),
    );
  }

  lines.push("", "## Pipelines", "");
  if (context.pipelines.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push(
      ...context.pipelines.slice(0, 10).map(
        (pipeline) =>
          "- #" +
          pipeline.id +
          ": " +
          (pipeline.status ?? "unknown") +
          (pipeline.web_url
            ? " [" + pipeline.web_url + "](" + pipeline.web_url + ")"
            : ""),
      ),
    );
  }

  lines.push("", "## Recent notes", "");
  if (context.recentNotes.length === 0) {
    lines.push("_None found._");
  } else {
    lines.push(
      ...context.recentNotes.slice(0, 10).map(
        (note) =>
          "- " +
          (note.created_at ?? "unknown date") +
          ": " +
          oneLine(note.body),
      ),
    );
  }

  if (context.warnings.length > 0) {
    lines.push(
      "",
      "## Warnings",
      "",
      ...context.warnings.map((warning) => "- " + warning),
    );
  }
  lines.push(
    "",
    "## Next action",
    "",
    context.mergeRequests.length === 0
      ? "Create an MR from the story and use oflow mr --story " + context.story.iid + " for its description."
      : "Refresh this context, complete the MR evidence checklist, then run oflow verify --story " + context.story.iid + ".",
    "",
  );
  return lines.join("\n");
}

export function chooseMergeRequest(context: StoryContext): GitLabMergeRequest | null {
  if (context.mergeRequests.length === 0) {
    return null;
  }
  if (context.branch) {
    const branchMatch = context.mergeRequests.find(
      (mergeRequest) => mergeRequest.source_branch === context.branch,
    );
    if (branchMatch) {
      return branchMatch;
    }
  }
  return context.mergeRequests[0];
}

export function formatMergeRequestTemplate(context: StoryContext): string {
  const criteria = context.criteria.length === 0
    ? "- [ ] AC-1: Add the story's acceptance criteria before opening this MR.\n  Evidence: TBD"
    : context.criteria
        .map(
          (criterion) =>
            "- [ ] " +
            criterion.id +
            ": " +
            criterion.text +
            "\n  Evidence: TBD",
        )
        .join("\n");
  return [
    "# Summary",
    "",
    "Implements story #" + context.story.iid + ": " + context.story.title,
    "",
    "## Acceptance criteria verification",
    "",
    criteria,
    "",
    "## Implementation notes",
    "",
    "- Describe the important implementation choices.",
    "- Link tests, screenshots, logs, or other concrete evidence above.",
    "",
    "Closes #" + context.story.iid,
    "",
  ].join("\n");
}

async function optionalFetch<T>(
  operation: () => Promise<T>,
  label: string,
  warnings: string[],
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(label + ": " + message);
    return ([] as unknown) as T;
  }
}

function normalizeEpic(
  issue: Record<string, unknown>,
): Record<string, unknown> | null {
  const candidates = [
    issue.epic,
    issue.parent,
    issue.work_item_parent,
    issue.parent_work_item,
  ];
  return candidates.find(isRecord) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatParent(parent: Record<string, unknown> | null): string {
  if (!parent) {
    return "_No epic or parent returned by GitLab._";
  }
  const title = String(parent.title ?? parent.name ?? "Untitled parent");
  const webUrl = typeof parent.web_url === "string" ? parent.web_url : null;
  const iid = parent.iid ? " #" + String(parent.iid) : "";
  return webUrl ? "[" + title + iid + "](" + webUrl + ")" : title + iid;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
