#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  clearGitLabToken,
  credentialsPath,
  getEnvironmentTokenName,
  getGitLabTokenSource,
  listStoredGitLabHosts,
  normalizeGitLabHost,
  promptForGitLabToken,
  readTokenFromStdin,
  saveGitLabToken,
} from "./auth.js";
import { assessStory, formatAssessmentMarkdown } from "./assess.js";
import { formatCapabilitiesMarkdown, getCapabilities } from "./capabilities.js";
import {
  formatGroupEpicListMarkdown,
  formatGroupEpicMarkdown,
  listProjectGroupEpics,
  loadProjectGroupEpic,
} from "./epics.js";
import { formatIterationListMarkdown, listIterations } from "./iterations.js";
import {
  chooseMergeRequest,
  compactMergeRequest,
  compactWorkItems,
  formatContextMarkdown,
  formatMergeRequestMarkdown,
  formatMergeRequestTemplate,
  formatWorkItemsMarkdown,
  loadMergeRequest,
  listWorkItemsPage,
  loadStoryContext,
} from "./context.js";
import { OflowError } from "./errors.js";
import { formatDoctor, doctor } from "./doctor.js";
import { getGitLabRemote, getRepoRoot } from "./git.js";
import { glabApiGet } from "./glab.js";
import { formatInstallResult, installProject } from "./install.js";
import {
  applyPlan,
  approvePlan,
  createBulkIssueLabelsPlan,
  createLabelCreatePlan,
  createLabelUpdatePlan,
  createIssueCreatePlan,
  createIssueNotePlan,
  createIssueUpdatePlan,
  createBoardCreatePlan,
  createBoardListCreatePlan,
  createBoardListUpdatePlan,
  createBoardUpdatePlan,
  createMilestoneCreatePlan,
  createMilestoneUpdatePlan,
  formatPlanMarkdown,
  verifyPlan,
} from "./plan.js";
import { resolveOptionalStoryIid, resolveStoryIid, startSession } from "./state.js";
import { formatSyncMarkdown, syncProject } from "./sync.js";
import { evaluateCriteria } from "./criteria.js";
import type {
  GitLabIssueFilters,
  GitLabIssueUpdate,
  GitLabBoardUpdate,
  GitLabLabelUpdate,
  GitLabMilestoneUpdate,
  IssueState,
  IterationState,
} from "./types.js";

interface CliOptions {
  command: string;
  authAction?: string;
  glabAction?: string;
  glabEndpoint?: string;
  root: string;
  story?: string;
  stories?: string;
  state?: string;
  agent?: string;
  host?: string;
  json: boolean;
  dryRun: boolean;
  tokenStdin: boolean;
  checkApi: boolean;
  epics: boolean;
  group: boolean;
  planResource?: string;
  planOperation?: string;
  planPath?: string;
  title?: string;
  description?: string;
  body?: string;
  name?: string;
  color?: string;
  newName?: string;
  label?: string;
  iteration?: string;
  startDate?: string;
  dueDate?: string;
  weight?: string;
  labels?: string;
  addLabels?: string;
  removeLabels?: string;
  milestone?: string;
  epic?: string;
  assignee?: string;
  author?: string;
  search?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  limit?: string;
  board?: string;
  list?: string;
  position?: string;
  iid?: string;
  full: boolean;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArgs(argv);
    if (options.command === "help" || options.command === "--help" || options.command === "-h") {
      process.stdout.write(helpText());
      return 0;
    }

    if (options.command === "auth") {
      if (options.dryRun) {
        throw new OflowError(
          "--dry-run is not supported with auth commands; no token is ever shown.",
          "INVALID_AUTH_OPTION",
        );
      }
      const root = options.host
        ? await optionalRepoRoot(options.root)
        : await getRepoRoot(options.root);
      return await runAuth(options, root);
    }

    if (options.command === "glab" && options.glabAction === "api") {
      if (!options.glabEndpoint) {
        throw new OflowError(
          "glab api requires a relative endpoint, for example projects/:fullpath/releases.",
          "MISSING_GLAB_ENDPOINT",
        );
      }
      const root = await getRepoRoot(options.root);
      const remote = await getGitLabRemote(root);
      const result = await glabApiGet({
        root,
        host: remote.host,
        endpoint: options.glabEndpoint,
      });
      print(options.json, result, JSON.stringify(result, null, 2) + "\n");
      return 0;
    }

    const root = await getRepoRoot(options.root);
    switch (options.command) {
      case "install": {
        const result = await installProject({
          root,
          agentMode: options.agent,
          dryRun: options.dryRun,
        });
        print(options.json, result, formatInstallResult(result));
        return 0;
      }
      case "work": {
        const state = normalizeIssueState(options.state);
        const filters = collectIssueFilters(options);
        const limit = parseIssueLimit(options.limit, 100);
        const issuePage = await listWorkItemsPage(
          root,
          state,
          filters,
          limit,
        );
        const issues = issuePage.items;
        print(
          options.json,
          {
            state,
            issues: compactWorkItems(issues),
            query: { state, issueLimit: limit, issueFilters: filters },
            workItemsMayBeTruncated: issuePage.pagination.hasNextPage,
            pagination: issuePage.pagination,
          },
          formatWorkItemsMarkdown(issues, state, {
            issueLimit: limit,
            issueFilters: filters,
            mayBeTruncated: issuePage.pagination.hasNextPage,
          }),
        );
        return 0;
      }
      case "epic": {
        const limit = parseIssueLimit(options.limit, 50);
        if (options.iid !== undefined) {
          const result = await loadProjectGroupEpic(
            root,
            parsePositiveInteger(options.iid, "epic IID"),
          );
          print(options.json, result, formatGroupEpicMarkdown(result));
        } else {
          const result = await listProjectGroupEpics(root, limit);
          print(options.json, result, formatGroupEpicListMarkdown(result));
        }
        return 0;
      }
      case "iteration": {
        const state = normalizeIterationState(options.state);
        const limit = parseIssueLimit(options.limit, 100);
        const result = await listIterations(
          root,
          state,
          limit,
          options.group ? "group" : "project",
        );
        print(options.json, result, formatIterationListMarkdown(result));
        return 0;
      }
      case "sync": {
        const state = normalizeIssueState(options.state);
        const storyIid = options.story
          ? await resolveStoryIid(root, options.story)
          : await resolveOptionalStoryIid(root);
        const result = await syncProject(root, {
          state,
          storyIid,
          issueFilters: collectIssueFilters(options),
          includeEpics: options.epics,
          issueLimit: options.limit === undefined
            ? undefined
            : parseIssueLimit(options.limit, 100),
        });
        print(options.json, result, formatSyncMarkdown(result));
        return result.warnings.length === 0 ? 0 : 1;
      }
      case "assess": {
        const storyIid = await resolveStoryIid(root, options.story);
        const result = await assessStory(root, storyIid);
        print(options.json, result, formatAssessmentMarkdown(result));
        return result.status === "satisfied" ? 0 : 1;
      }
      case "capabilities": {
        const result = await getCapabilities();
        print(options.json, result, formatCapabilitiesMarkdown(result));
        return 0;
      }
      case "plan": {
        if (options.planResource === "issues" && options.planOperation === "labels") {
          if (options.stories === undefined) {
            throw new OflowError(
              "plan issues labels requires --stories <iid,...>.",
              "MISSING_FLAG_VALUE",
            );
          }
          const stored = await createBulkIssueLabelsPlan(
            root,
            parseIssueIids(options.stories),
            {
              add_labels: options.addLabels,
              remove_labels: options.removeLabels,
            },
          );
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        if (options.planResource === "issue" && options.planOperation === "create") {
          if (options.title === undefined) {
            throw new OflowError(
              "plan issue create requires --title.",
              "MISSING_FLAG_VALUE",
            );
          }
          const stored = await createIssueCreatePlan(root, {
            title: options.title,
            description: options.description,
            labels: options.labels,
            milestone: options.milestone,
            epic_id: options.epic === undefined
              ? undefined
              : parseEpicId(options.epic, false),
            due_date: options.dueDate,
            weight: options.weight === undefined
              ? undefined
              : parseNonNegativeInteger(options.weight, "issue weight"),
          }, options.assignee);
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        if (options.planResource === "issue" &&
          (options.planOperation === "update" || options.planOperation === "note")) {
          const storyIid = await resolveStoryIid(root, options.story);
          if (options.planOperation === "note") {
            if (options.body === undefined) {
              throw new OflowError(
                "plan issue note requires --body.",
                "MISSING_FLAG_VALUE",
              );
            }
            const stored = await createIssueNotePlan(root, storyIid, options.body);
            print(options.json, stored, formatPlanMarkdown(stored));
            return 0;
          }
          const changes: GitLabIssueUpdate = {
            title: options.title,
            description: options.description,
            labels: options.labels,
            add_labels: options.addLabels,
            remove_labels: options.removeLabels,
            ...normalizeIssueMilestone(options.milestone),
            epic_id: options.epic === undefined
              ? undefined
              : parseEpicId(options.epic, true),
            due_date: options.dueDate,
            weight: options.weight === undefined
              ? undefined
              : parseNonNegativeInteger(options.weight, "issue weight"),
            state_event: normalizeIssueUpdateState(options.state),
          };
          const stored = await createIssueUpdatePlan(root, storyIid, changes, options.assignee);
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        if (options.planResource === "label" && options.planOperation === "create") {
          if (options.name === undefined || options.color === undefined) {
            throw new OflowError(
              "plan label create requires --name and --color.",
              "MISSING_FLAG_VALUE",
            );
          }
          const stored = await createLabelCreatePlan(root, {
            name: options.name,
            color: options.color,
            description: options.description,
          });
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        if (options.planResource === "label" && options.planOperation === "update") {
          if (options.label === undefined) {
            throw new OflowError(
              "plan label update requires --label.",
              "MISSING_FLAG_VALUE",
            );
          }
          const changes: GitLabLabelUpdate = {
            new_name: options.newName,
            color: options.color,
            description: options.description,
          };
          const stored = await createLabelUpdatePlan(root, options.label, changes);
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        if (options.planResource === "milestone" && options.planOperation === "create") {
          if (options.title === undefined) {
            throw new OflowError(
              "plan milestone create requires --title.",
              "MISSING_FLAG_VALUE",
            );
          }
          const stored = await createMilestoneCreatePlan(root, {
            title: options.title,
            description: options.description,
            start_date: options.startDate,
            due_date: options.dueDate,
          });
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        if (options.planResource === "milestone" && options.planOperation === "update") {
          if (options.milestone === undefined) {
            throw new OflowError(
              "plan milestone update requires --milestone <iid>.",
              "MISSING_FLAG_VALUE",
            );
          }
          const milestoneIid = parsePositiveInteger(options.milestone, "milestone IID");
          const changes: GitLabMilestoneUpdate = {
            title: options.title,
            description: options.description,
            start_date: options.startDate,
            due_date: options.dueDate,
            state_event: normalizeMilestoneUpdateState(options.state),
          };
          const stored = await createMilestoneUpdatePlan(root, milestoneIid, changes);
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        if (options.planResource === "board" && options.planOperation === "create") {
          if (options.name === undefined) {
            throw new OflowError(
              "plan board create requires --name.",
              "MISSING_FLAG_VALUE",
            );
          }
          const stored = await createBoardCreatePlan(root, options.name);
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        if (options.planResource === "board" && options.planOperation === "update") {
          if (options.board === undefined) {
            throw new OflowError(
              "plan board update requires --board <id>.",
              "MISSING_FLAG_VALUE",
            );
          }
          const changes: GitLabBoardUpdate = { name: options.name };
          const stored = await createBoardUpdatePlan(
            root,
            parsePositiveInteger(options.board, "board ID"),
            changes,
          );
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        if (options.planResource === "board-list" && options.planOperation === "create") {
          if (options.board === undefined || options.label === undefined) {
            throw new OflowError(
              "plan board-list create requires --board <id> and --label <name-or-id>.",
              "MISSING_FLAG_VALUE",
            );
          }
          const stored = await createBoardListCreatePlan(
            root,
            parsePositiveInteger(options.board, "board ID"),
            options.label,
          );
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        if (options.planResource === "board-list" && options.planOperation === "update") {
          if (options.board === undefined || options.list === undefined || options.position === undefined) {
            throw new OflowError(
              "plan board-list update requires --board <id>, --list <id>, and --position <n>.",
              "MISSING_FLAG_VALUE",
            );
          }
          const stored = await createBoardListUpdatePlan(
            root,
            parsePositiveInteger(options.board, "board ID"),
            parsePositiveInteger(options.list, "board list ID"),
            parsePosition(options.position),
          );
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        {
          throw new OflowError(
            "Use oflow plan issue create/update/note, plan issues labels, plan label create/update, plan milestone create/update, plan board create/update, or plan board-list create/update with the required fields.",
            "UNSUPPORTED_PLAN",
          );
        }
      }
      case "approve": {
        if (!options.planPath) {
          throw new OflowError(
            "approve requires a .oflow/state/plans/<plan-id>.json path.",
            "MISSING_PLAN_PATH",
          );
        }
        const stored = await approvePlan(root, options.planPath);
        print(options.json, stored, formatPlanMarkdown(stored));
        return 0;
      }
      case "apply": {
        if (!options.planPath) {
          throw new OflowError(
            "apply requires a .oflow/state/plans/<plan-id>.json path.",
            "MISSING_PLAN_PATH",
          );
        }
        const stored = await applyPlan(root, options.planPath);
        print(options.json, stored, formatPlanMarkdown(stored));
        return 0;
      }
      case "doctor": {
        const result = await doctor(root, { checkApi: options.checkApi });
        print(options.json, result, formatDoctor(result));
        return result.warnings.length === 0 ? 0 : 1;
      }
      case "start": {
        const storyIid = await resolveStoryIid(root, options.story);
        const session = await startSession(root, storyIid);
        print(
          options.json,
          session,
          "Started story #" + session.storyIid + " on branch " + (session.branch ?? "detached") + ".\n",
        );
        return 0;
      }
      case "context": {
        const storyIid = await resolveStoryIid(root, options.story);
        const result = await loadStoryContext(root, storyIid);
        print(options.json, result, formatContextMarkdown(result));
        return 0;
      }
      case "mr": {
        if (options.iid !== undefined) {
          const mergeRequest = await loadMergeRequest(
            root,
            parsePositiveInteger(options.iid, "merge request IID"),
          );
          const summary = compactMergeRequest(mergeRequest, options.full);
          print(options.json, summary, formatMergeRequestMarkdown(summary));
          return 0;
        }
        const storyIid = await resolveStoryIid(root, options.story);
        const context = await loadStoryContext(root, storyIid);
        const output = formatMergeRequestTemplate(context);
        print(options.json, { storyIid, template: output }, output);
        return 0;
      }
      case "verify": {
        if (options.planPath) {
          const stored = await verifyPlan(root, options.planPath);
          print(options.json, stored, formatPlanMarkdown(stored));
          return stored.plan.verification?.passed ? 0 : 1;
        }
        const storyIid = await resolveStoryIid(root, options.story);
        const context = await loadStoryContext(root, storyIid);
        const mergeRequest = chooseMergeRequest(context);
        const pipelineStatus = context.pipelines[0]?.status ?? null;
        const result = evaluateCriteria(
          context.criteria,
          mergeRequest?.description,
          pipelineStatus,
        );
        const output = {
          storyIid,
          mergeRequest,
          pipeline: context.pipelines[0] ?? null,
          warnings: context.warnings,
          result,
        };
        print(options.json, output, formatVerification(output));
        return result.passed ? 0 : 1;
      }
      default:
        throw new OflowError(
          "Unknown command " + options.command + ". Run oflow help.",
          "UNKNOWN_COMMAND",
        );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write("oflow: " + message + "\n");
    return 1;
  }
}

async function runAuth(
  options: CliOptions,
  root: string | null,
): Promise<number> {
  const host = await resolveAuthHost(root, options.host);
  const action = options.authAction ?? "status";
  if (action === "login" || action === "set") {
    const token = options.tokenStdin
      ? await readTokenFromStdin()
      : await promptForGitLabToken();
    await saveGitLabToken(host, token);
    const status = authStatus(host);
    print(
      options.json,
      { ...status, action: "saved" },
      "Stored a GitLab token for " + host + ".\n" +
        "Credentials are kept outside the repository at " +
        credentialsPath() + ".\n",
    );
    return 0;
  }
  if (action === "clear" || action === "logout") {
    const removed = await clearGitLabToken(host);
    const status = authStatus(host);
    print(
      options.json,
      { ...status, action: "cleared", removed },
      (removed
        ? "Removed the stored GitLab token for " + host + "."
        : "No stored GitLab token was found for " + host + ".") + "\n",
    );
    return 0;
  }
  if (action === "status") {
    const status = authStatus(host);
    print(options.json, status, formatAuthStatus(status));
    return 0;
  }
  throw new OflowError(
    "Unknown auth action. Use login, status, or clear.",
    "UNKNOWN_AUTH_ACTION",
  );
}

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0] ?? "help";
  let firstOptionIndex = 1;
  const options: CliOptions = {
    command,
    root: process.cwd(),
    json: false,
    dryRun: false,
    tokenStdin: false,
    checkApi: false,
    epics: false,
    group: false,
    full: false,
  };

  if (command === "auth" && argv[1] && !argv[1].startsWith("-")) {
    options.authAction = argv[1];
    firstOptionIndex = 2;
  } else if (command === "plan") {
    options.planResource = argv[1];
    options.planOperation = argv[2];
    firstOptionIndex = 3;
  } else if (command === "glab") {
    options.glabAction = argv[1];
    options.glabEndpoint = argv[2];
    firstOptionIndex = 3;
  } else if (
    (command === "approve" || command === "apply") &&
    argv[1] &&
    !argv[1].startsWith("-")
  ) {
    options.planPath = argv[1];
    firstOptionIndex = 2;
  }

  for (let index = firstOptionIndex; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--token-stdin" || argument === "--stdin") {
      options.tokenStdin = true;
    } else if (argument === "--check-api") {
      options.checkApi = true;
    } else if (argument === "--epics") {
      options.epics = true;
    } else if (argument === "--group") {
      options.group = true;
    } else if (
      argument === "--story" ||
      argument === "--stories" ||
      argument === "--state" ||
      argument === "--agent" ||
      argument === "--root" ||
      argument === "--host" ||
      argument === "--title" ||
      argument === "--description" ||
      argument === "--body" ||
      argument === "--name" ||
      argument === "--color" ||
      argument === "--new-name" ||
      argument === "--label" ||
      argument === "--iteration" ||
      argument === "--start-date" ||
      argument === "--due-date" ||
      argument === "--weight" ||
      argument === "--labels" ||
      argument === "--add-labels" ||
      argument === "--remove-labels" ||
      argument === "--milestone" ||
      argument === "--epic" ||
      argument === "--assignee" ||
      argument === "--author" ||
      argument === "--search" ||
      argument === "--updated-after" ||
      argument === "--updated-before" ||
      argument === "--limit" ||
      argument === "--board" ||
      argument === "--list" ||
      argument === "--position" ||
      argument === "--iid" ||
      argument === "--plan"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new OflowError(argument + " requires a value.", "MISSING_FLAG_VALUE");
      }
      index += 1;
      if (argument === "--story") {
        options.story = value;
      } else if (argument === "--stories") {
        options.stories = value;
      } else if (argument === "--state") {
        options.state = value;
      } else if (argument === "--agent") {
        options.agent = value;
      } else if (argument === "--host") {
        options.host = value;
      } else if (argument === "--title") {
        options.title = value;
      } else if (argument === "--description") {
        options.description = value;
      } else if (argument === "--body") {
        options.body = value;
      } else if (argument === "--name") {
        options.name = value;
      } else if (argument === "--color") {
        options.color = value;
      } else if (argument === "--new-name") {
        options.newName = value;
      } else if (argument === "--label") {
        options.label = value;
      } else if (argument === "--iteration") {
        options.iteration = value;
      } else if (argument === "--start-date") {
        options.startDate = value;
      } else if (argument === "--due-date") {
        options.dueDate = value;
      } else if (argument === "--weight") {
        options.weight = value;
      } else if (argument === "--labels") {
        options.labels = value;
      } else if (argument === "--add-labels") {
        options.addLabels = value;
      } else if (argument === "--remove-labels") {
        options.removeLabels = value;
      } else if (argument === "--milestone") {
        options.milestone = value;
      } else if (argument === "--epic") {
        options.epic = value;
      } else if (argument === "--assignee") {
        options.assignee = value;
      } else if (argument === "--author") {
        options.author = value;
      } else if (argument === "--search") {
        options.search = value;
      } else if (argument === "--updated-after") {
        options.updatedAfter = value;
      } else if (argument === "--updated-before") {
        options.updatedBefore = value;
      } else if (argument === "--limit") {
        options.limit = value;
      } else if (argument === "--board") {
        options.board = value;
      } else if (argument === "--list") {
        options.list = value;
      } else if (argument === "--position") {
        options.position = value;
      } else if (argument === "--iid") {
        options.iid = value;
      } else if (argument === "--plan") {
        options.planPath = value;
      } else {
        options.root = value;
      }
    } else if (argument.startsWith("--story=")) {
      options.story = argument.slice("--story=".length);
    } else if (argument.startsWith("--stories=")) {
      const value = argument.slice("--stories=".length);
      if (!value) {
        throw new OflowError("--stories requires a value.", "MISSING_FLAG_VALUE");
      }
      options.stories = value;
    } else if (argument.startsWith("--state=")) {
      options.state = argument.slice("--state=".length);
    } else if (argument.startsWith("--agent=")) {
      options.agent = argument.slice("--agent=".length);
    } else if (argument.startsWith("--root=")) {
      options.root = argument.slice("--root=".length);
    } else if (argument.startsWith("--host=")) {
      const value = argument.slice("--host=".length);
      if (!value || value.startsWith("-")) {
        throw new OflowError("--host requires a value.", "MISSING_FLAG_VALUE");
      }
      options.host = value;
    } else if (argument.startsWith("--title=")) {
      options.title = argument.slice("--title=".length);
    } else if (argument.startsWith("--description=")) {
      options.description = argument.slice("--description=".length);
    } else if (argument.startsWith("--body=")) {
      options.body = argument.slice("--body=".length);
    } else if (argument.startsWith("--name=")) {
      options.name = argument.slice("--name=".length);
    } else if (argument.startsWith("--color=")) {
      options.color = argument.slice("--color=".length);
    } else if (argument.startsWith("--new-name=")) {
      options.newName = argument.slice("--new-name=".length);
    } else if (argument.startsWith("--label=")) {
      options.label = argument.slice("--label=".length);
    } else if (argument.startsWith("--iteration=")) {
      const value = argument.slice("--iteration=".length);
      if (!value) {
        throw new OflowError("--iteration requires a value.", "MISSING_FLAG_VALUE");
      }
      options.iteration = value;
    } else if (argument.startsWith("--start-date=")) {
      options.startDate = argument.slice("--start-date=".length);
    } else if (argument.startsWith("--due-date=")) {
      options.dueDate = argument.slice("--due-date=".length);
    } else if (argument.startsWith("--weight=")) {
      options.weight = argument.slice("--weight=".length);
    } else if (argument.startsWith("--labels=")) {
      options.labels = argument.slice("--labels=".length);
    } else if (argument.startsWith("--add-labels=")) {
      options.addLabels = argument.slice("--add-labels=".length);
    } else if (argument.startsWith("--remove-labels=")) {
      options.removeLabels = argument.slice("--remove-labels=".length);
    } else if (argument.startsWith("--milestone=")) {
      options.milestone = argument.slice("--milestone=".length);
    } else if (argument.startsWith("--epic=")) {
      options.epic = argument.slice("--epic=".length);
    } else if (argument.startsWith("--assignee=")) {
      options.assignee = argument.slice("--assignee=".length);
    } else if (argument.startsWith("--author=")) {
      options.author = argument.slice("--author=".length);
    } else if (argument.startsWith("--search=")) {
      options.search = argument.slice("--search=".length);
    } else if (argument.startsWith("--updated-after=")) {
      options.updatedAfter = argument.slice("--updated-after=".length);
    } else if (argument.startsWith("--updated-before=")) {
      options.updatedBefore = argument.slice("--updated-before=".length);
    } else if (argument.startsWith("--limit=")) {
      options.limit = argument.slice("--limit=".length);
    } else if (argument.startsWith("--board=")) {
      options.board = argument.slice("--board=".length);
    } else if (argument.startsWith("--list=")) {
      options.list = argument.slice("--list=".length);
    } else if (argument.startsWith("--position=")) {
      options.position = argument.slice("--position=".length);
    } else if (argument.startsWith("--iid=")) {
      const value = argument.slice("--iid=".length);
      if (!value) {
        throw new OflowError("--iid requires a value.", "MISSING_FLAG_VALUE");
      }
      options.iid = value;
    } else if (argument === "--full") {
      options.full = true;
    } else if (argument.startsWith("--plan=")) {
      const value = argument.slice("--plan=".length);
      if (!value) {
        throw new OflowError("--plan requires a value.", "MISSING_FLAG_VALUE");
      }
      options.planPath = value;
    } else if (
      argument === "--token" ||
      argument === "--gitlab-token" ||
      /^--(?:token|gitlab-token)=/i.test(argument)
    ) {
      throw new OflowError(
        "Do not pass GitLab tokens as command-line arguments. Use oflow auth login or --token-stdin.",
        "UNSAFE_TOKEN_ARGUMENT",
      );
    } else if (argument === "--help" || argument === "-h") {
      return { ...options, command: "help" };
    } else {
      throw new OflowError("Unknown option " + argument + ".", "UNKNOWN_OPTION");
    }
  }
  return options;
}

function print(json: boolean, value: unknown, markdown: string): void {
  process.stdout.write(json ? JSON.stringify(value, null, 2) + "\n" : markdown);
}

function normalizeIssueState(value: string | undefined): IssueState {
  const state = value?.trim().toLowerCase() || "opened";
  if (state === "opened" || state === "closed" || state === "all") {
    return state;
  }
  throw new OflowError(
    "Unknown issue state \"" + value + "\". Use opened, closed, or all.",
    "INVALID_ISSUE_STATE",
  );
}

function normalizeIterationState(value: string | undefined): IterationState {
  const state = value?.trim().toLowerCase() || "all";
  if (state === "opened" || state === "upcoming" || state === "current" ||
    state === "closed" || state === "all") {
    return state;
  }
  throw new OflowError(
    "Unknown iteration state \"" + value + "\". Use opened, upcoming, current, closed, or all.",
    "INVALID_ITERATION_STATE",
  );
}

function normalizeIssueUpdateState(
  value: string | undefined,
): GitLabIssueUpdate["state_event"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === "closed") {
    return "close";
  }
  if (value === "opened") {
    return "reopen";
  }
  throw new OflowError(
    "Unknown issue update state \"" + value + "\". Use opened or closed.",
    "INVALID_ISSUE_UPDATE_STATE",
  );
}

function normalizeIssueMilestone(
  value: string | undefined,
): Pick<GitLabIssueUpdate, "milestone" | "milestone_id"> {
  if (value === undefined) {
    return {};
  }
  if (["none", "null", "unassigned"].includes(value.trim().toLowerCase())) {
    return { milestone_id: 0 };
  }
  return { milestone: value };
}

function normalizeMilestoneUpdateState(
  value: string | undefined,
): GitLabMilestoneUpdate["state_event"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === "closed") {
    return "close";
  }
  if (value === "active") {
    return "activate";
  }
  throw new OflowError(
    "Unknown milestone state \"" + value + "\". Use active or closed.",
    "INVALID_MILESTONE_STATE",
  );
}

function parsePositiveInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value)) {
    throw new OflowError(field + " must be a positive integer.", "INVALID_MILESTONE_IID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new OflowError(field + " must be a positive integer.", "INVALID_MILESTONE_IID");
  }
  return parsed;
}

function parseIssueIids(value: string): number[] {
  const parts = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new OflowError(
      "--stories must contain one or more comma-separated issue IIDs.",
      "INVALID_ISSUE_IIDS",
    );
  }
  return parts.map((part) => parsePositiveInteger(part, "issue IID"));
}

function parseNonNegativeInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value)) {
    throw new OflowError(field + " must be a non-negative integer.", "INVALID_ISSUE_WEIGHT");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OflowError(field + " must be a non-negative integer.", "INVALID_ISSUE_WEIGHT");
  }
  return parsed;
}

function parseEpicId(value: string, allowClear: boolean): number {
  const normalized = value.trim().toLowerCase();
  if (allowClear && ["none", "null", "unassigned"].includes(normalized)) {
    return 0;
  }
  if (!/^\d+$/.test(value)) {
    throw new OflowError(
      "Epic ID must be a positive integer" + (allowClear ? " or none." : "."),
      "INVALID_EPIC_ID",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new OflowError(
      "Epic ID must be a positive integer" + (allowClear ? " or none." : "."),
      "INVALID_EPIC_ID",
    );
  }
  return parsed;
}

function parseIssueLimit(value: string | undefined, defaultLimit: number): number {
  if (value === undefined) {
    return defaultLimit;
  }
  if (!/^\d+$/.test(value)) {
    throw new OflowError(
      "Issue limit must be an integer between 1 and 100.",
      "INVALID_ISSUE_LIMIT",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new OflowError(
      "Issue limit must be an integer between 1 and 100.",
      "INVALID_ISSUE_LIMIT",
    );
  }
  return parsed;
}

function collectIssueFilters(options: CliOptions): GitLabIssueFilters {
  const filters: GitLabIssueFilters = {};
  if (options.label !== undefined) {
    filters.label = requiredFilter(options.label, "--label");
  }
  if (options.milestone !== undefined) {
    filters.milestone = requiredFilter(options.milestone, "--milestone");
  }
  if (options.iteration !== undefined) {
    filters.iteration = requiredFilter(options.iteration, "--iteration");
  }
  if (options.epic !== undefined) {
    filters.epic = normalizeEpicFilter(options.epic);
  }
  if (options.assignee !== undefined) {
    filters.assignee = requiredFilter(options.assignee, "--assignee");
  }
  if (options.author !== undefined) {
    filters.author = requiredFilter(options.author, "--author");
  }
  if (options.search !== undefined) {
    filters.search = requiredFilter(options.search, "--search");
  }
  if (options.updatedAfter !== undefined) {
    filters.updatedAfter = requiredFilter(options.updatedAfter, "--updated-after");
  }
  if (options.updatedBefore !== undefined) {
    filters.updatedBefore = requiredFilter(options.updatedBefore, "--updated-before");
  }
  return filters;
}

function requiredFilter(value: string, flag: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new OflowError(flag + " cannot be empty.", "INVALID_ISSUE_FILTER");
  }
  return normalized;
}

function normalizeEpicFilter(value: string): string {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  if (["none", "null", "unassigned"].includes(lower)) {
    return "none";
  }
  if (lower === "any") {
    return "any";
  }
  if (/^[1-9]\d*$/.test(normalized)) {
    const parsed = Number(normalized);
    if (Number.isSafeInteger(parsed)) {
      return String(parsed);
    }
  }
  throw new OflowError(
    "Epic filter must be a positive integer, none, or any.",
    "INVALID_ISSUE_FILTER",
  );
}

function parsePosition(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new OflowError(
      "Board list position must be a non-negative integer.",
      "INVALID_BOARD_POSITION",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OflowError(
      "Board list position must be a non-negative integer.",
      "INVALID_BOARD_POSITION",
    );
  }
  return parsed;
}

function formatVerification(output: {
  storyIid: number;
  mergeRequest: { iid: number; web_url?: string; title: string } | null;
  pipeline: { id: number; status?: string; web_url?: string } | null;
  warnings: string[];
  result: ReturnType<typeof evaluateCriteria>;
}): string {
  const lines = [
    "# oflow verify",
    "",
    "Story: #" + output.storyIid,
    "Merge request: " +
      (output.mergeRequest
        ? "!" + output.mergeRequest.iid + " " + output.mergeRequest.title
        : "none"),
    "Pipeline: " +
      (output.pipeline
        ? "#" + output.pipeline.id + " " + (output.pipeline.status ?? "unknown")
        : "none"),
    "",
    output.result.passed ? "PASS" : "BLOCKED",
    "",
    "Criteria:",
    ...output.result.checks.map(
      (check) =>
        "- " +
        (check.verified ? "PASS" : "FAIL") +
        " " +
        check.id +
        ": " +
        check.reason,
    ),
  ];
  if (output.result.reasons.length > 0) {
    lines.push("", "Reasons:", ...output.result.reasons.map((reason) => "- " + reason));
  }
  if (output.warnings.length > 0) {
    lines.push("", "Warnings:", ...output.warnings.map((warning) => "- " + warning));
  }
  return lines.join("\n") + "\n";
}

interface AuthStatus {
  host: string;
  activeSource: "environment" | "stored" | null;
  environmentVariable: string | null;
  storedForHost: boolean;
  storedHosts: string[];
  credentialsFile: string;
}

function authStatus(host: string): AuthStatus {
  const source = getGitLabTokenSource(host);
  const storedHosts = listStoredGitLabHosts();
  return {
    host,
    activeSource: source?.kind ?? null,
    environmentVariable: getEnvironmentTokenName(),
    storedForHost: storedHosts.includes(host),
    storedHosts,
    credentialsFile: credentialsPath(),
  };
}

function formatAuthStatus(status: AuthStatus): string {
  const active = status.activeSource === "environment"
    ? "environment (" + status.environmentVariable + ")"
    : status.activeSource === "stored"
      ? "stored credentials"
      : "missing";
  const lines = [
    "# oflow auth",
    "",
    "GitLab host: " + status.host,
    "Active token: " + active,
    "Stored token for host: " + (status.storedForHost ? "yes" : "no"),
    "Credentials file: " + status.credentialsFile,
  ];
  if (status.storedHosts.length > 0) {
    lines.push("Stored hosts: " + status.storedHosts.join(", "));
  }
  return lines.join("\n") + "\n";
}

async function resolveAuthHost(
  root: string | null,
  requestedHost?: string,
): Promise<string> {
  if (requestedHost) {
    return normalizeGitLabHost(requestedHost);
  }
  if (!root) {
    throw new OflowError(
      "Run this command inside a GitLab repository or pass --host <host>.",
      "MISSING_GITLAB_HOST",
    );
  }
  const remote = await getGitLabRemote(root);
  return normalizeGitLabHost(remote.host);
}

async function optionalRepoRoot(start: string): Promise<string | null> {
  try {
    return await getRepoRoot(start);
  } catch {
    return null;
  }
}

function helpText(): string {
  return [
    "oflow - GitLab-first workflow for Claude and Codex",
    "",
    "Commands:",
    "  auth login [--host <host>]          store a GitLab token outside the repo",
    "  auth set --token-stdin [--host]     store a token from stdin",
    "  auth status [--host <host>]         inspect token configuration",
    "  auth clear [--host <host>]          remove a stored token",
    "  install [--agent auto|claude|codex|both] [--dry-run]",
    "  doctor [--check-api]",
    "  work [filters] [--json]             list current GitLab work items",
    "  epic [--iid <iid>] [--limit <n>]    list or inspect group epics",
    "  iteration [--group] [--state <state>] list project or group sprints",
    "  sync [filters] [--story <iid>]      compact project and Scrum snapshot",
    "  assess --story <iid> [--json]       compact story progress and local evidence",
    "  capabilities [--json]               show supported and planned operations",
    "  glab api <GET endpoint> [--json]     optional read-only glab fallback",
    "  plan issue create --title <title>   prepare an auditable issue create",
    "  plan issue update --story <iid>     prepare an auditable issue update",
    "  plan issues labels --stories 1,2    prepare guarded bulk label changes",
    "  plan issue note --story <iid>       prepare an auditable issue note",
    "  plan label create --name --color    prepare an auditable label create",
    "  plan label update --label <name>    prepare an auditable label update",
    "  plan milestone create --title       prepare an auditable milestone create",
    "  plan milestone update --milestone  prepare an auditable milestone update",
    "  plan board create --name             prepare an auditable board create",
    "  plan board update --board --name     prepare an auditable board update",
    "  plan board-list create --board --label prepare a label-backed board list",
    "  plan board-list update --board --list --position reorder a board list",
    "  approve <plan.json>                  approve a local plan artifact",
    "  apply <plan.json>                    apply an approved plan",
    "  start --story <iid>",
    "  context --story <iid> [--json]",
    "  mr --story <iid>",
    "  mr --iid <iid> [--full] [--json]",
    "  verify --story <iid> [--json]",
    "",
    "Options:",
    "  --root <path>  run against a repository below this path",
    "  --json         print machine-readable output",
    "  --dry-run      preview install changes",
    "  --token-stdin  read a token without putting it in shell history",
    "  --plan <path>  verify a plan artifact instead of a story",
    "  --epic <id|none> assign or clear a Premium/Ultimate epic on an issue",
    "  --stories 1,2 use with plan issues labels for bounded bulk changes",
    "  issue labels: --labels replaces; --add-labels/--remove-labels preserve other labels",
    "  filters: --label, --milestone, --iteration, --epic, --assignee, --author, --search, --updated-after, --updated-before, --limit 1..100",
    "  sync --epics  opt in to bounded group-epic reads (GraphQL)",
    "  iteration --group  read the parent-group sprint schedule (requires group access)",
  ].join("\n") + "\n";
}

const entryPoint = process.argv[1];
if (entryPoint && isCliEntryPoint(entryPoint)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

function isCliEntryPoint(entryPointPath: string): boolean {
  try {
    return realpathSync(entryPointPath) === realpathSync(new URL(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(entryPointPath).href;
  }
}
