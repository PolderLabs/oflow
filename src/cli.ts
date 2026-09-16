#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { chooseMergeRequest, formatContextMarkdown, formatMergeRequestTemplate, loadStoryContext } from "./context.js";
import { OflowError } from "./errors.js";
import { formatDoctor, doctor } from "./doctor.js";
import { getRepoRoot } from "./git.js";
import { formatInstallResult, installProject } from "./install.js";
import { resolveStoryIid, startSession } from "./state.js";
import { evaluateCriteria } from "./criteria.js";

interface CliOptions {
  command: string;
  root: string;
  story?: string;
  agent?: string;
  json: boolean;
  dryRun: boolean;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArgs(argv);
    if (options.command === "help" || options.command === "--help" || options.command === "-h") {
      process.stdout.write(helpText());
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
      case "doctor": {
        const result = await doctor(root);
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

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0] ?? "help";
  const options: CliOptions = {
    command,
    root: process.cwd(),
    json: false,
    dryRun: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--story" || argument === "--agent" || argument === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new OflowError(argument + " requires a value.", "MISSING_FLAG_VALUE");
      }
      index += 1;
      if (argument === "--story") {
        options.story = value;
      } else if (argument === "--agent") {
        options.agent = value;
      } else {
        options.root = value;
      }
    } else if (argument.startsWith("--story=")) {
      options.story = argument.slice("--story=".length);
    } else if (argument.startsWith("--agent=")) {
      options.agent = argument.slice("--agent=".length);
    } else if (argument.startsWith("--root=")) {
      options.root = argument.slice("--root=".length);
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

function helpText(): string {
  return [
    "oflow - GitLab-first workflow for Claude and Codex",
    "",
    "Commands:",
    "  install [--agent auto|claude|codex|both] [--dry-run]",
    "  doctor",
    "  start --story <iid>",
    "  context --story <iid> [--json]",
    "  mr --story <iid>",
    "  verify --story <iid> [--json]",
    "",
    "Options:",
    "  --root <path>  run against a repository below this path",
    "  --json         print machine-readable output",
    "  --dry-run      preview install changes",
  ].join("\n") + "\n";
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
