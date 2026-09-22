#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
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
import { checkStory, formatCheckMarkdown, formatFinishMarkdown, formatHandoffMarkdown, formatStartMarkdown, finishStory, handoffStory, startWork } from "./lifecycle.js";
import { assessStory, formatAssessmentMarkdown } from "./assess.js";
import { formatAuditMarkdown, readAudit } from "./audit.js";
import { formatCapabilitiesMarkdown, getCapabilities } from "./capabilities.js";
import { formatIterationCadenceMarkdown, listIterationCadences } from "./cadences.js";
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
  formatWorkItemSummariesMarkdown,
  getCurrentGitLabUser,
  loadMergeRequest,
  listWorkItemsPage,
  loadStoryContext,
  selectVerificationEvidence,
} from "./context.js";
import { OflowError } from "./errors.js";
import { startDashboard } from "./dashboard.js";
import { formatDoctor, doctor } from "./doctor.js";
import { readText } from "./fs.js";
import { resolvePresentation } from "./presentation.js";
import { getGitLabRemote, getRepoRoot } from "./git.js";
import { glabApiGet } from "./glab.js";
import { formatInstallResult, installProject } from "./install.js";
import { resolveAuth, probeCapabilities, type AuthCapability, type AuthResolution } from "./auth-resolver.js";
import {
  applyPlan,
  approvePlan,
  listPlans,
  discardPlan,
  createBulkIssueIterationPlan,
  createBulkIssueLabelsPlan,
  createBulkIssuePlanningPlan,
  createLabelCreatePlan,
  createLabelUpdatePlan,
  createIssueCreatePlan,
  createIssueIterationUpdatePlan,
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
  applyPlanDelegated,
  ingestExecutionReceipt,
  createMergeRequestCreatePlan,
} from "./plan.js";
import { resolveOptionalStoryIid, resolveStoryIid, startSession } from "./state.js";
import {
  compactSyncSummary,
  formatSyncMarkdown,
  formatSyncSummaryMarkdown,
  syncProject,
} from "./sync.js";
import { evaluateCriteria } from "./criteria.js";
import {
  formatReadModelStatusMarkdown,
  markReadModelStale,
  readReadModelStatus,
  requestReadModelRefresh,
} from "./read-model.js";
import { readWorkItemsCache, saveWorkItemsCache } from "./work-cache.js";
import type {
  GitLabIssueFilters,
  GitLabIssueUpdate,
  GitLabBoardUpdate,
  GitLabLabelUpdate,
  GitLabMilestoneUpdate,
  IssueType,
  IterationState,
  IssueState,
} from "./types.js";
import { isIssueType } from "./types.js";
import type { ExecutionReceipt } from "./actions.js";
import { isCanonicalActionName } from "./actions.js";

interface CliOptions {
  command: string;
  authAction?: string;
  cacheAction?: string;
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
  probe: boolean;
  epics: boolean;
  group: boolean;
  cached: boolean;
  refresh: boolean;
  summary: boolean;
  planResource?: string;
  planOperation?: string;
  planPath?: string;
  title?: string;
  description?: string;
  sourceBranch?: string;
  targetBranch?: string;
  issueType?: string;
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
  staleDays?: string;
  limit?: string;
  board?: string;
  list?: string;
  position?: string;
  iid?: string;
  port?: string;
  full: boolean;
  mine: boolean;
  withGitLabMcp: boolean;
  receipt?: string;
  delegate: boolean;
  force: boolean;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArgs(argv);
    if (options.force) process.stderr.write("WARNING: --force overrides plan expiry/session protection, not target, digest, state or remote preconditions.\n");
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
          withGitLabMcp: options.withGitLabMcp,
        });
        print(options.json, result, formatInstallResult(result));
        return 0;
      }
      case "work": {
        if (options.mine && options.assignee !== undefined) {
          throw new OflowError(
            "Use either --mine or --assignee, not both.",
            "CONFLICTING_WORK_ASSIGNEE_FILTERS",
          );
        }
        const state = normalizeIssueState(options.state);
        const filters = collectIssueFilters(options);
        const limit = parseIssueLimit(options.limit, 100);
        const cacheQuery = {
          state,
          issueLimit: limit,
          issueFilters: filters,
          mine: options.mine,
        };
        const remote = await getGitLabRemote(root);
        if (options.cached) {
          const cached = await readWorkItemsCache({
            root,
            host: remote.host,
            projectPath: remote.projectPath,
            query: cacheQuery,
          });
          const displayFilters = options.mine && cached.cache.actorUsername
            ? { ...filters, assignee: cached.cache.actorUsername }
            : filters;
          print(
            options.json,
            {
              state,
              issues: cached.items,
              query: { state, issueLimit: limit, issueFilters: displayFilters, mine: options.mine },
              workItemsMayBeTruncated: cached.workItemsMayBeTruncated,
              pagination: cached.pagination,
              cache: cached.cache,
              warnings: [],
            },
            formatWorkItemSummariesMarkdown(cached.items, state, {
              issueLimit: limit,
              issueFilters: displayFilters,
              mayBeTruncated: cached.workItemsMayBeTruncated,
              cache: cached.cache,
            }),
          );
          return 0;
        }

        let effectiveFilters = filters;
        let actorUsername: string | null = null;
        if (options.mine) {
          actorUsername = (await getCurrentGitLabUser(root)).username;
          effectiveFilters = { ...filters, assignee: actorUsername };
        }
        const issuePage = await listWorkItemsPage(root, state, effectiveFilters, limit);
        const items = compactWorkItems(issuePage.items);
        const warnings: string[] = [];
        let savedAt = new Date().toISOString();
        try {
          const saved = await saveWorkItemsCache({
            root,
            host: remote.host,
            projectPath: remote.projectPath,
            query: cacheQuery,
            actorUsername,
            items,
            pagination: issuePage.pagination,
          });
          savedAt = saved.savedAt;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push("Could not save local SQLite work cache: " + message);
        }
        const cache = {
          source: "remote" as const,
          savedAt,
          ageSeconds: 0,
          actorUsername,
        };
        print(
          options.json,
          {
            state,
            issues: items,
            query: { state, issueLimit: limit, issueFilters: effectiveFilters, mine: options.mine },
            workItemsMayBeTruncated: issuePage.pagination.hasNextPage,
            pagination: issuePage.pagination,
            cache,
            warnings,
          },
          formatWorkItemSummariesMarkdown(items, state, {
            issueLimit: limit,
            issueFilters: effectiveFilters,
            mayBeTruncated: issuePage.pagination.hasNextPage,
            cache,
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
      case "cadence": {
        const limit = parseIssueLimit(options.limit, 20);
        const result = await listIterationCadences(root, limit);
        print(options.json, result, formatIterationCadenceMarkdown(result));
        return 0;
      }
      case "sync": {
        if (options.cached && options.refresh) {
          throw new OflowError(
            "sync --cached and --refresh cannot be used together.",
            "CONFLICTING_SYNC_CACHE_OPTIONS",
          );
        }
        const state = normalizeIssueState(options.state);
        const storyIid = options.story
          ? await resolveStoryIid(root, options.story)
          : await resolveOptionalStoryIid(root);
        const result = await syncProject(root, {
          state,
          storyIid,
          issueFilters: collectIssueFilters(options),
          includeEpics: options.epics,
          staleDays: options.staleDays === undefined
            ? undefined
            : parseStaleDays(options.staleDays),
          issueLimit: options.limit === undefined
            ? undefined
            : parseIssueLimit(options.limit, 100),
          cache: options.cached ? "cached" : "refresh",
        });
        if (options.summary) {
          const summary = compactSyncSummary(result);
          print(options.json, summary, formatSyncSummaryMarkdown(summary));
        } else {
          print(options.json, result, formatSyncMarkdown(result));
        }
        return result.warnings.length === 0 ? 0 : 1;
      }
      case "assess": {
        const storyIid = await resolveStoryIid(root, options.story);
        const result = await assessStory(root, storyIid);
        print(options.json, result, formatAssessmentMarkdown(result));
        // A completed assessment is a successful read even when its findings
        // are unknown, in-progress, or blocked. The status is in the report;
        // a non-zero exit code is reserved for an operational failure.
        return 0;
      }
      case "start": {
        const result = await startWork({
          root,
          story: options.story === undefined ? undefined : await resolveStoryIid(root, options.story),
        });
        print(options.json, result, formatStartMarkdown(result));
        return 0;
      }
      case "check": {
        const result = await checkStory({
          root,
          story: options.story === undefined ? undefined : await resolveStoryIid(root, options.story),
        });
        print(options.json, result, formatCheckMarkdown(result));
        return 0;
      }
      case "finish": {
        const result = await finishStory({
          root,
          story: options.story === undefined ? undefined : await resolveStoryIid(root, options.story),
        });
        print(options.json, result, formatFinishMarkdown(result, resolvePresentation(process.stdout)));
        return result.ready ? 0 : 1;
      }
      case "handoff": {
        const result = await handoffStory({
          root,
          story: options.story === undefined ? undefined : await resolveStoryIid(root, options.story),
        });
        print(options.json, result, formatHandoffMarkdown(result));
        return 0;
      }
      case "capabilities": {
        let probe: { root: string; host: string; projectPath: string } | undefined;
        if (options.probe) {
          try {
            const remote = await getGitLabRemote(root);
            probe = { root, host: remote.host, projectPath: remote.projectPath };
          } catch {
            probe = undefined;
          }
        }
        const result = await getCapabilities(probe ? { probe } : {});
        print(options.json, result, formatCapabilitiesMarkdown(result));
        return 0;
      }
      case "audit": {
        const result = await readAudit(
          root,
          options.limit === undefined
            ? undefined
            : parseIssueLimit(options.limit, 100),
        );
        print(options.json, result, formatAuditMarkdown(result));
        return 0;
      }
      case "plan": {
        if (options.planResource === "list") {
          const plans = await listPlans(root);
          print(options.json, { plans }, plans.length === 0 ? "No local plans.\n" :
            plans.map((plan) => [plan.id, plan.state, plan.operation, plan.target,
              "age=" + plan.ageSeconds + "s", "expires=" + (plan.expiresAt ?? "unknown"),
              plan.lifecycle].join(" · ")).join("\n") + "\n");
          return 0;
        }
        if (options.planResource === "discard") {
          if (options.dryRun) throw new OflowError("plan discard does not support --dry-run; use plan list to inspect plans.", "INVALID_PLAN_OPTION");
          if (!options.planPath) throw new OflowError("plan discard requires a plan ID.", "MISSING_PLAN_ID");
          const result = await discardPlan(root, options.planPath);
          print(options.json, result, "Discarded local plan " + result.id + ".\n");
          return 0;
        }
        if (options.planResource === "assess" && options.planOperation === "update") {
          assertAssessmentPlanOptions(options);
          if (options.assignee === undefined && options.milestone === undefined) {
            throw new OflowError(
              "plan assess requires --assignee and/or --milestone; it never invents planning values.",
              "EMPTY_PLAN",
            );
          }
          const storyIid = await resolveStoryIid(root, options.story);
          const assessment = await assessStory(root, storyIid);
          const stored = await createIssueUpdatePlan(
            root,
            storyIid,
            normalizeIssueMilestone(options.milestone),
            options.assignee,
            {
              generatedAt: assessment.generatedAt,
              status: assessment.status,
              recommendations: assessment.nextActions,
            },
          );
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
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
        if (options.planResource === "issues" && options.planOperation === "update") {
          if (options.stories === undefined) {
            throw new OflowError(
              "plan issues update requires --stories <iid,...>.",
              "MISSING_FLAG_VALUE",
            );
          }
          if (options.iteration !== undefined) {
            assertBulkIterationPlanOptions(options);
            const stored = await createBulkIssueIterationPlan(
              root,
              parseIssueIids(options.stories),
              options.iteration,
            );
            print(options.json, stored, formatPlanMarkdown(stored));
            return 0;
          }
          assertBulkPlanningOptions(options);
          const stored = await createBulkIssuePlanningPlan(
            root,
            parseIssueIids(options.stories),
            normalizeIssueMilestone(options.milestone),
            options.assignee,
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
            issue_type: normalizeIssueType(options.issueType),
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
          if (options.iteration !== undefined) {
            assertIssueIterationPlanOptions(options);
            const stored = await createIssueIterationUpdatePlan(
              root,
              storyIid,
              options.iteration,
            );
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
            issue_type: normalizeIssueType(options.issueType),
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
        if (options.planResource === "merge-request" && options.planOperation === "create") {
          if (options.story === undefined) {
            throw new OflowError(
              "plan merge-request create requires --story <iid>.",
              "MISSING_STORY",
            );
          }
          const storyIid = await resolveStoryIid(root, options.story);
          const stored = await createMergeRequestCreatePlan({
            root,
            storyIid,
            sourceBranch: options.sourceBranch,
            targetBranch: options.targetBranch,
            title: options.title,
            description: options.description,
          });
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        {
          throw new OflowError(
            "Use oflow plan issue create/update/note, plan issues labels, plan label create/update, plan milestone create/update, plan board create/update, plan board-list create/update, or plan merge-request create with the required fields.",
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
        const stored = await approvePlan(root, options.planPath, { force: options.force });
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
        if (options.receipt) {
          const receipt = parseExecutionReceipt(await readText(resolve(options.receipt)));
          const stored = await ingestExecutionReceipt(root, options.planPath, receipt, { force: options.force });
          await markReadModelStale(root, "A remote plan was applied; refresh before trusting cached planning data.");
          print(options.json, stored, formatPlanMarkdown(stored));
          return 0;
        }
        if (options.delegate) {
          const { descriptor } = await applyPlanDelegated(root, options.planPath, { force: options.force });
          print(
            options.json,
            descriptor,
            [
              "# oflow apply --delegate",
              "",
              "Execute this action through the agent runtime's GitLab MCP tool:",
              "",
              "  action:      " + descriptor.action.name,
              "  project:     " + descriptor.action.arguments.project,
              "  source:      " + descriptor.action.arguments.sourceBranch,
              "  target:      " + descriptor.action.arguments.targetBranch,
              "  title:       " + descriptor.action.arguments.title,
              "",
              "Save the tool response as JSON, then run:",
              "  " + descriptor.afterExecution.command,
            ].join("\n") + "\n",
          );
          return 0;
        }
        const stored = await applyPlan(root, options.planPath, { force: options.force });
        await markReadModelStale(root, "A remote plan was applied; refresh before trusting cached planning data.");
        print(options.json, stored, formatPlanMarkdown(stored));
        return 0;
      }
      case "dashboard": {
        if (options.cached || options.refresh) {
          throw new OflowError(
            "dashboard is local-only; use `oflow sync --refresh` in the CLI to refresh GitLab data.",
            "INVALID_DASHBOARD_OPTION",
          );
        }
        const dashboard = await startDashboard(root, {
          port: options.port === undefined ? undefined : parseDashboardPort(options.port),
        });
        process.stdout.write(
          "oflow dashboard listening at " + dashboard.url + "\n" +
          "Local-only read model; press Ctrl-C to stop.\n",
        );
        await waitForDashboardShutdown(dashboard.close);
        return 0;
      }
      case "cache": {
        const action = options.cacheAction ?? "status";
        if (action === "status") {
          const result = await readReadModelStatus(root);
          print(options.json, result, formatReadModelStatusMarkdown(result));
          return result.state === "invalid" || result.state === "unsupported" ||
            result.state === "migration-required" ? 1 : 0;
        }
        if (action === "request-refresh") {
          const accepted = await requestReadModelRefresh(root, "cli");
          print(
            options.json,
            {
              accepted,
              command: accepted ? "oflow sync --refresh" : null,
              credentialsExposed: false,
            },
            accepted
              ? "Refresh requested locally. Run `oflow sync --refresh` to contact GitLab.\n"
              : "No local read model exists. Run `oflow sync --refresh` first.\n",
          );
          return 0;
        }
        throw new OflowError(
          "Unknown cache action. Use status or request-refresh.",
          "UNKNOWN_CACHE_ACTION",
        );
      }
      case "doctor": {
        const result = await doctor(root, { checkApi: options.checkApi });
        print(options.json, result, formatDoctor(result, resolvePresentation(process.stdout)));
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
        const verificationEvidence = selectVerificationEvidence(context);
        const mergeRequest = verificationEvidence.mergeRequest;
        const pipelineStatus = verificationEvidence.pipeline?.status ?? null;
        const result = evaluateCriteria(
          context.criteria,
          mergeRequest?.description,
          pipelineStatus,
        );
        const output = {
          storyIid,
          mergeRequest,
          pipeline: verificationEvidence.pipeline,
          warnings: [
            ...context.warnings,
            ...(verificationEvidence.warning ? [verificationEvidence.warning] : []),
          ].filter((warning, index, warnings) => warnings.indexOf(warning) === index),
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
    const resolution = await resolveAuth({ host, root: root ?? undefined });
    const status = authStatus(host);
    let capabilities: AuthCapability[] | undefined;
    if (options.probe && root) {
      try {
        let projectPathForProbe: string | undefined;
        try {
          const remote = await getGitLabRemote(root);
          if (remote.host === host) projectPathForProbe = remote.projectPath;
        } catch {
          projectPathForProbe = undefined;
        }
        capabilities = await probeCapabilities(
          { host, ...(projectPathForProbe ? { projectPath: projectPathForProbe } : {}) },
          resolution.sources,
          resolution.readBackend,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolution.notes.push("Capability probe failed: " + message);
      }
    }
    const resolutionWithCapabilities: AuthResolution = capabilities
      ? { ...resolution, capabilities }
      : resolution;
    print(
      options.json,
      { ...status, resolution: resolutionWithCapabilities },
      formatAuthStatus(status, resolutionWithCapabilities),
    );
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
    probe: false,
    epics: false,
    group: false,
    cached: false,
    refresh: false,
    summary: false,
    full: false,
    mine: false,
    withGitLabMcp: false,
    delegate: false,
    force: false,
  };

  if (command === "auth" && argv[1] && !argv[1].startsWith("-")) {
    options.authAction = argv[1];
    firstOptionIndex = 2;
  } else if (command === "cache" && argv[1] && !argv[1].startsWith("-")) {
    options.cacheAction = argv[1];
    firstOptionIndex = 2;
  } else if (command === "plan") {
    options.planResource = argv[1];
    if (options.planResource === "list") {
      firstOptionIndex = 2;
    } else if (options.planResource === "discard") {
      firstOptionIndex = 2;
      if (argv[2] && !argv[2].startsWith("-")) {
        options.planPath = argv[2];
        firstOptionIndex = 3;
      }
    } else if (argv[2] && !argv[2].startsWith("-")) {
      options.planOperation = argv[2];
      firstOptionIndex = 3;
    } else {
      options.planOperation = "update";
      firstOptionIndex = 2;
    }
  } else if (command === "glab") {
    options.glabAction = argv[1];
    options.glabEndpoint = argv[2];
    firstOptionIndex = 3;
  } else if (
    (command === "approve" || command === "apply" || command === "verify") &&
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
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--token-stdin" || argument === "--stdin") {
      options.tokenStdin = true;
    } else if (argument === "--check-api") {
      options.checkApi = true;
    } else if (argument === "--probe") {
      options.probe = true;
    } else if (argument === "--epics") {
      options.epics = true;
    } else if (argument === "--group") {
      options.group = true;
    } else if (argument === "--cached") {
      options.cached = true;
    } else if (argument === "--refresh") {
      options.refresh = true;
    } else if (argument === "--summary") {
      options.summary = true;
    } else if (argument === "--mine") {
      options.mine = true;
    } else if (argument === "--with-gitlab-mcp") {
      options.withGitLabMcp = true;
    } else if (argument === "--delegate") {
      options.delegate = true;
    } else if (
      argument === "--story" ||
      argument === "--stories" ||
      argument === "--state" ||
      argument === "--agent" ||
      argument === "--root" ||
      argument === "--host" ||
      argument === "--title" ||
      argument === "--source-branch" ||
      argument === "--target-branch" ||
      argument === "--receipt" ||
      argument === "--description" ||
      argument === "--issue-type" ||
      argument === "--type" ||
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
      argument === "--stale-days" ||
      argument === "--limit" ||
      argument === "--board" ||
      argument === "--list" ||
      argument === "--position" ||
      argument === "--iid" ||
      argument === "--port" ||
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
      } else if (argument === "--source-branch") {
        options.sourceBranch = value;
      } else if (argument === "--target-branch") {
        options.targetBranch = value;
      } else if (argument === "--receipt") {
        options.receipt = value;
      } else if (argument === "--description") {
        options.description = value;
      } else if (argument === "--issue-type" || argument === "--type") {
        options.issueType = value;
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
      } else if (argument === "--stale-days") {
        options.staleDays = value;
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
      } else if (argument === "--port") {
        options.port = value;
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
    } else if (argument.startsWith("--issue-type=")) {
      const value = argument.slice("--issue-type=".length);
      if (!value) {
        throw new OflowError("--issue-type requires a value.", "MISSING_FLAG_VALUE");
      }
      options.issueType = value;
    } else if (argument.startsWith("--type=")) {
      const value = argument.slice("--type=".length);
      if (!value) {
        throw new OflowError("--type requires a value.", "MISSING_FLAG_VALUE");
      }
      options.issueType = value;
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
    } else if (argument.startsWith("--stale-days=")) {
      const value = argument.slice("--stale-days=".length);
      if (!value) {
        throw new OflowError("--stale-days requires a value.", "MISSING_FLAG_VALUE");
      }
      options.staleDays = value;
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
    } else if (argument.startsWith("--port=")) {
      const value = argument.slice("--port=".length);
      if (!value) {
        throw new OflowError("--port requires a value.", "MISSING_FLAG_VALUE");
      }
      options.port = value;
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
  if ((options.cached || options.refresh) && options.command !== "sync" && options.command !== "work") {
    throw new OflowError(
      "--cached and --refresh are only supported with sync and work.",
      "INVALID_SYNC_CACHE_OPTION",
    );
  }
  if (options.mine && options.command !== "work") {
    throw new OflowError(
      "--mine is only supported with work.",
      "INVALID_MINE_OPTION",
    );
  }
  if (options.cached && options.refresh) {
    throw new OflowError(
      "sync --cached and --refresh cannot be used together.",
      "CONFLICTING_SYNC_CACHE_OPTIONS",
    );
  }
  if (options.port !== undefined && options.command !== "dashboard") {
    throw new OflowError("--port is only supported with dashboard.", "INVALID_DASHBOARD_OPTION");
  }
  if (options.force && command !== "approve" && command !== "apply") {
    throw new OflowError("--force is only supported with approve and apply.", "INVALID_FORCE_OPTION");
  }
  return options;
}

function print(json: boolean, value: unknown, markdown: string): void {
  process.stdout.write(json ? JSON.stringify(value, null, 2) + "\n" : markdown);
}

function parseDashboardPort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new OflowError(
      "Dashboard port must be an integer between 0 and 65535.",
      "INVALID_DASHBOARD_PORT",
    );
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new OflowError(
      "Dashboard port must be an integer between 0 and 65535.",
      "INVALID_DASHBOARD_PORT",
    );
  }
  return port;
}

function parseExecutionReceipt(content: string | null): ExecutionReceipt {
  if (content === null) {
    throw new OflowError("Receipt file not found.", "RECEIPT_FILE_NOT_FOUND");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new OflowError("Receipt file is not valid JSON.", "INVALID_RECEIPT_JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new OflowError("Receipt must be a JSON object.", "INVALID_RECEIPT_JSON");
  }
  const record = parsed as Record<string, unknown>;
  const backend = record.backend;
  const action = record.action;
  const executedAt = record.executedAt;
  const success = record.success;
  if (
    backend !== "gitlab-mcp" ||
    typeof action !== "string" ||
    !isCanonicalActionName(action) ||
    typeof executedAt !== "string" ||
    typeof success !== "boolean"
  ) {
    throw new OflowError(
      "Receipt must contain backend 'gitlab-mcp', a canonical action name, executedAt, and success fields.",
      "INVALID_RECEIPT_JSON",
    );
  }
  return {
    backend,
    action,
    executedAt,
    success,
    result: record.result,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

async function waitForDashboardShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      void close().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
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

function normalizeIssueType(value: string | undefined): IssueType | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (isIssueType(normalized)) {
    return normalized;
  }
  throw new OflowError(
    "Unknown issue type \"" + value + "\". Use issue, incident, test_case, or task.",
    "INVALID_ISSUE_TYPE",
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

function parseStaleDays(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new OflowError(
      "Stale days must be an integer between 1 and 3650.",
      "INVALID_STALE_DAYS",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw new OflowError(
      "Stale days must be an integer between 1 and 3650.",
      "INVALID_STALE_DAYS",
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

function formatAuthStatus(status: AuthStatus, resolution?: AuthResolution): string {
  const lines = [
    "# oflow auth",
    "",
    "GitLab host: " + status.host,
  ];
  if (resolution) {
    lines.push(
      "Selected CLI backend: " + resolution.readBackend,
      "Selected agent execution preference: " +
        (resolution.mutationBackend === "none" ? "unavailable" : resolution.mutationBackend),
      "",
      "AUTH SOURCES",
    );
    if (resolution.sources.length === 0) {
      lines.push("  - none detected");
    }
    for (const source of resolution.sources) {
      const state = source.authenticated === true
        ? "authenticated"
        : source.authenticated === "runtime-owned"
          ? "runtime-owned OAuth (agent runtime)"
          : "not authenticated";
      lines.push("  " + source.source + ": " + state);
      for (const note of source.notes ?? []) {
        lines.push("    " + note);
      }
    }
    lines.push(
      "",
      "Stored hosts: " +
        (status.storedHosts.length > 0 ? status.storedHosts.join(", ") : "none"),
      "Credentials file: " + status.credentialsFile,
    );
    if (!resolution.authenticated) {
      lines.push(
        "",
        "No CLI-authenticated transport. Run `glab auth login` or set GITLAB_TOKEN.",
      );
    }
    if (resolution.capabilities && resolution.capabilities.length > 0) {
      lines.push("", "CAPABILITIES");
      for (const cap of resolution.capabilities) {
        const marker = cap.usable ? "usable" : "unusable";
        const sourceLabel = cap.source ? " (" + cap.source + ")" : "";
        lines.push("  " + cap.id + " [" + cap.backend + sourceLabel + "]: " +
          cap.probe + " - " + marker);
        if (cap.reason) lines.push("    " + cap.reason);
        if (cap.remediation) lines.push("    remediation: " + cap.remediation);
      }
    }
    return lines.join("\n") + "\n";
  }
  lines.push(
    "Active token: " + (status.activeSource ?? "missing"),
    "Stored token for host: " + (status.storedForHost ? "yes" : "no"),
    "Credentials file: " + status.credentialsFile,
  );
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
    "  auth status [--host <host>]         inspect auth sources, backends, and tokens",
    "  auth clear [--host <host>]          remove a stored token",
    "  install [--agent auto|claude|codex|omp|both] [--dry-run] [--with-gitlab-mcp]",
    "  doctor [--check-api]",
    "  start [--story <iid>] [--json]         one compact work context for agents",
    "  check [--story <iid>] [--json]         unified story, evidence, and policy check",
    "  finish [--story <iid>] [--json]        gated completion check with close command",
    "  handoff [--story <iid>] [--json]       compact context for the next agent",
    "  work [filters] [--json]             list current GitLab work items",
    "  epic [--iid <iid>] [--limit <n>]    list or inspect group epics",
    "  iteration [--group] [--state <state>] list project or group sprints",
    "  cadence [--limit <n>]               list parent-group iteration cadences",
    "  sync [filters] [--story <iid>]      compact project and Scrum snapshot",
    "  sync --summary                       token-light counts and planning health",
    "  assess --story <iid> [--json]       compact story progress and local evidence",
    "  capabilities [--json]               show supported and planned operations",
    "  audit [--limit <n>] [--json]         read local plan lifecycle history",
    "  cache status [--json]                inspect local cache age/schema/invalidation",
    "  cache request-refresh                record a local refresh request (no network)",
    "  dashboard [--port <n>]               serve the local read-only planning dashboard",
    "  glab api <GET endpoint> [--json]     optional read-only glab fallback",
    "  plan issue create --title <title> [--type <type>] prepare an auditable work-item create",
    "  plan issue update --story <iid> [--type <type>] prepare an auditable work-item update",
    "  plan issue update --story <iid> --iteration <title|iid|none>",
    "  plan issues labels --stories 1,2    prepare guarded bulk label changes",
    "  plan issues update --stories 1,2    prepare guarded owner/timebox changes",
    "  plan issues update --stories 1,2 --iteration <title|iid|none>",
    "  plan assess --story <iid>           prepare owner/timebox plan from assessment",
    "  plan issue note --story <iid>       prepare an auditable issue note",
    "  plan label create --name --color    prepare an auditable label create",
    "  plan label update --label <name>    prepare an auditable label update",
    "  plan milestone create --title       prepare an auditable milestone create",
    "  plan milestone update --milestone  prepare an auditable milestone update",
    "  plan board create --name             prepare an auditable board create",
    "  plan board update --board --name     prepare an auditable board update",
    "  plan board-list create --board --label prepare a label-backed board list",
    "  plan board-list update --board --list --position reorder a board list",
    "  plan list [--json]                  list local plan state, age, target and expiry",
    "  plan discard <id>                   discard an unexecuted draft/approved plan (audited)",
    "  approve <plan.json>                  approve a local plan artifact",
    "  apply <plan.json>                    apply an approved plan",
    "  apply <plan.json> --delegate         emit a delegated GitLab MCP action",
    "  apply <plan.json> --receipt <file>   ingest an executed delegated action receipt",
    "  verify <plan.json>                   independently verify an applied plan",
    "  start --story <iid>",
    "  context --story <iid> [--json]",
    "  mr --story <iid>",
    "  mr --iid <iid> [--full] [--json]",
    "  verify --story <iid> [--json]",
    "",
    "Plan lifecycle: 24-hour TTL from creation. OFLOW_SESSION_ID binds agent sessions;",
    "without it, TTL alone applies (old shell-PID IDs are implicit). Legacy plans remain readable.",
    "--force on approve/apply overrides legacy/expired/cross-session guards with an audit event.",
    "Force requires a live target recheck; it never bypasses state, digest or remote preconditions.",
    "Only explicit session IDs are compared. Receipts and verification are not TTL/session-gated.",
    "",
    "Options:",
    "  --root <path>  run against a repository below this path",
    "  --json         print machine-readable output",
    "  --dry-run      preview install changes",
    "  --token-stdin  read a token without putting it in shell history",
    "  --plan <path>  verify a plan artifact instead of a story",
    "  --epic <id|none> assign or clear a Premium/Ultimate epic on an issue",
    "  --type/--issue-type issue|incident|test_case|task set the GitLab work-item type",
    "  --stories 1,2 use with plan issues labels/update for bounded bulk changes",
    "  issue labels: --labels replaces; --add-labels/--remove-labels preserve other labels",
    "  filters: --label, --milestone, --iteration, --epic, --assignee, --mine, --author, --search, --updated-after, --updated-before, --limit 1..100",
    "  sync --stale-days <n>  add an advisory stale-work-item finding without extra API calls",
    "  sync --cached  read the matching local snapshot without GitLab access",
    "  sync --refresh  explicitly refresh the remote snapshot and local cache",
    "  dashboard       binds only to 127.0.0.1 and never receives GitLab credentials",
    "  work --mine --refresh  refresh work items assigned to the authenticated user",
    "  work --mine --cached   read assigned work items from local SQLite cache",
    "  sync --epics  opt in to bounded group-epic reads (GraphQL)",
    "  iteration --group  read the parent-group sprint schedule (requires group access)",
    "  cadence             inspect group sprint scheduling (read-only GraphQL)",
  ].join("\n") + "\n";
}

function assertBulkPlanningOptions(options: CliOptions): void {
  const unsupported = [
    ["--title", options.title],
    ["--description", options.description],
    ["--issue-type", options.issueType],
    ["--body", options.body],
    ["--name", options.name],
    ["--color", options.color],
    ["--new-name", options.newName],
    ["--label", options.label],
    ["--iteration", options.iteration],
    ["--start-date", options.startDate],
    ["--due-date", options.dueDate],
    ["--weight", options.weight],
    ["--labels", options.labels],
    ["--add-labels", options.addLabels],
    ["--remove-labels", options.removeLabels],
    ["--epic", options.epic],
    ["--state", options.state],
    ["--author", options.author],
    ["--search", options.search],
    ["--updated-after", options.updatedAfter],
    ["--updated-before", options.updatedBefore],
    ["--stale-days", options.staleDays],
    ["--limit", options.limit],
    ["--board", options.board],
    ["--list", options.list],
    ["--position", options.position],
    ["--iid", options.iid],
    ["--group", options.group ? "true" : undefined],
    ["--epics", options.epics ? "true" : undefined],
    ["--full", options.full ? "true" : undefined],
  ].filter(([, value]) => value !== undefined);
  if (unsupported.length > 0) {
    throw new OflowError(
      "plan issues update supports only --milestone and --assignee; use plan issue update for other fields.",
      "UNSUPPORTED_BULK_ISSUE_FIELD",
    );
  }
}

function assertBulkIterationPlanOptions(options: CliOptions): void {
  const unsupported = [
    ["--title", options.title],
    ["--description", options.description],
    ["--issue-type", options.issueType],
    ["--body", options.body],
    ["--name", options.name],
    ["--color", options.color],
    ["--new-name", options.newName],
    ["--label", options.label],
    ["--start-date", options.startDate],
    ["--due-date", options.dueDate],
    ["--weight", options.weight],
    ["--labels", options.labels],
    ["--add-labels", options.addLabels],
    ["--remove-labels", options.removeLabels],
    ["--milestone", options.milestone],
    ["--epic", options.epic],
    ["--assignee", options.assignee],
    ["--state", options.state],
    ["--author", options.author],
    ["--search", options.search],
    ["--updated-after", options.updatedAfter],
    ["--updated-before", options.updatedBefore],
    ["--stale-days", options.staleDays],
    ["--limit", options.limit],
    ["--board", options.board],
    ["--list", options.list],
    ["--position", options.position],
    ["--iid", options.iid],
    ["--group", options.group ? "true" : undefined],
    ["--epics", options.epics ? "true" : undefined],
    ["--cached", options.cached ? "true" : undefined],
    ["--refresh", options.refresh ? "true" : undefined],
    ["--full", options.full ? "true" : undefined],
  ].filter(([, value]) => value !== undefined);
  if (unsupported.length > 0) {
    throw new OflowError(
      "Bulk iteration assignment supports only --stories and --iteration; use plan issues update for owner/timebox changes.",
      "UNSUPPORTED_BULK_ITERATION_COMBINATION",
    );
  }
}

function assertIssueIterationPlanOptions(options: CliOptions): void {
  const unsupported = [
    ["--title", options.title],
    ["--description", options.description],
    ["--issue-type", options.issueType],
    ["--body", options.body],
    ["--name", options.name],
    ["--color", options.color],
    ["--new-name", options.newName],
    ["--label", options.label],
    ["--start-date", options.startDate],
    ["--due-date", options.dueDate],
    ["--weight", options.weight],
    ["--labels", options.labels],
    ["--add-labels", options.addLabels],
    ["--remove-labels", options.removeLabels],
    ["--milestone", options.milestone],
    ["--epic", options.epic],
    ["--assignee", options.assignee],
    ["--state", options.state],
    ["--author", options.author],
    ["--search", options.search],
    ["--updated-after", options.updatedAfter],
    ["--updated-before", options.updatedBefore],
    ["--stale-days", options.staleDays],
    ["--limit", options.limit],
    ["--board", options.board],
    ["--list", options.list],
    ["--position", options.position],
    ["--iid", options.iid],
    ["--stories", options.stories],
    ["--group", options.group ? "true" : undefined],
    ["--epics", options.epics ? "true" : undefined],
    ["--cached", options.cached ? "true" : undefined],
    ["--refresh", options.refresh ? "true" : undefined],
    ["--full", options.full ? "true" : undefined],
  ].filter(([, value]) => value !== undefined);
  if (unsupported.length > 0) {
    throw new OflowError(
      "Iteration assignment is a single-field issue plan; do not combine --iteration with other issue or filter flags.",
      "UNSUPPORTED_ITERATION_COMBINATION",
    );
  }
}

function assertAssessmentPlanOptions(options: CliOptions): void {
  const unsupported = [
    ["--title", options.title],
    ["--description", options.description],
    ["--issue-type", options.issueType],
    ["--body", options.body],
    ["--name", options.name],
    ["--color", options.color],
    ["--new-name", options.newName],
    ["--label", options.label],
    ["--iteration", options.iteration],
    ["--start-date", options.startDate],
    ["--due-date", options.dueDate],
    ["--weight", options.weight],
    ["--labels", options.labels],
    ["--add-labels", options.addLabels],
    ["--remove-labels", options.removeLabels],
    ["--epic", options.epic],
    ["--state", options.state],
    ["--author", options.author],
    ["--search", options.search],
    ["--updated-after", options.updatedAfter],
    ["--updated-before", options.updatedBefore],
    ["--stale-days", options.staleDays],
    ["--limit", options.limit],
    ["--board", options.board],
    ["--list", options.list],
    ["--position", options.position],
    ["--iid", options.iid],
    ["--stories", options.stories],
    ["--group", options.group ? "true" : undefined],
    ["--epics", options.epics ? "true" : undefined],
    ["--full", options.full ? "true" : undefined],
  ].filter(([, value]) => value !== undefined);
  if (unsupported.length > 0) {
    throw new OflowError(
      "plan assess supports only --story, --assignee, and --milestone.",
      "UNSUPPORTED_ASSESSMENT_PLAN_FIELD",
    );
  }
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
