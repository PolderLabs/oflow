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
import {
  chooseMergeRequest,
  formatContextMarkdown,
  formatMergeRequestTemplate,
  formatWorkItemsMarkdown,
  listWorkItems,
  loadStoryContext,
} from "./context.js";
import { OflowError } from "./errors.js";
import { formatDoctor, doctor } from "./doctor.js";
import { getGitLabRemote, getRepoRoot } from "./git.js";
import { formatInstallResult, installProject } from "./install.js";
import { resolveStoryIid, startSession } from "./state.js";
import { evaluateCriteria } from "./criteria.js";
import type { IssueState } from "./types.js";

interface CliOptions {
  command: string;
  authAction?: string;
  root: string;
  story?: string;
  state?: string;
  agent?: string;
  host?: string;
  json: boolean;
  dryRun: boolean;
  tokenStdin: boolean;
  checkApi: boolean;
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
        const issues = await listWorkItems(root, state);
        print(
          options.json,
          { state, issues },
          formatWorkItemsMarkdown(issues, state),
        );
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
        const storyIid = await resolveStoryIid(root, options.story);
        const context = await loadStoryContext(root, storyIid);
        const output = formatMergeRequestTemplate(context);
        print(options.json, { storyIid, template: output }, output);
        return 0;
      }
      case "verify": {
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
  };

  if (command === "auth" && argv[1] && !argv[1].startsWith("-")) {
    options.authAction = argv[1];
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
    } else if (
      argument === "--story" ||
      argument === "--state" ||
      argument === "--agent" ||
      argument === "--root" ||
      argument === "--host"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new OflowError(argument + " requires a value.", "MISSING_FLAG_VALUE");
      }
      index += 1;
      if (argument === "--story") {
        options.story = value;
      } else if (argument === "--state") {
        options.state = value;
      } else if (argument === "--agent") {
        options.agent = value;
      } else if (argument === "--host") {
        options.host = value;
      } else {
        options.root = value;
      }
    } else if (argument.startsWith("--story=")) {
      options.story = argument.slice("--story=".length);
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
    "  work [--state opened|closed|all]    list current GitLab work items",
    "  start --story <iid>",
    "  context --story <iid> [--json]",
    "  mr --story <iid>",
    "  verify --story <iid> [--json]",
    "",
    "Options:",
    "  --root <path>  run against a repository below this path",
    "  --json         print machine-readable output",
    "  --dry-run      preview install changes",
    "  --token-stdin  read a token without putting it in shell history",
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
