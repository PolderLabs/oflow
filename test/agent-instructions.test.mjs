import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import {
  agentInstructionBlock,
  OMP_AGENTS_BRIDGE_MARKDOWN,
  COPILOT_INSTRUCTIONS_MARKDOWN,
  OFLOW_README_MARKDOWN,
  MERGE_REQUEST_TEMPLATE_MARKDOWN,
} from "../dist/templates.js";

// The managed instruction blocks are how oflow tells an agent how to drive it.
// An agent follows them literally, so a command named there that does not
// exist is a dead end at the exact moment the agent needs help. One such name
// shipped -- an internal helper presented as a command -- so these tests decide
// existence by running the real binary rather than trusting a hand-kept list,
// since the list is what drifted.

const cli = join(process.cwd(), "dist", "cli.js");

const BLOCKS = {
  "agentInstructionBlock(codex)": agentInstructionBlock("codex"),
  "agentInstructionBlock(claude)": agentInstructionBlock("claude"),
  "agentInstructionBlock(omp)": agentInstructionBlock("omp"),
  "OMP_AGENTS_BRIDGE_MARKDOWN": OMP_AGENTS_BRIDGE_MARKDOWN,
  "COPILOT_INSTRUCTIONS_MARKDOWN": COPILOT_INSTRUCTIONS_MARKDOWN,
  "OFLOW_README_MARKDOWN": OFLOW_README_MARKDOWN,
  "MERGE_REQUEST_TEMPLATE_MARKDOWN": MERGE_REQUEST_TEMPLATE_MARKDOWN,
};

/** Words that appear after "oflow" in prose but are not subcommands. */
const NOT_COMMANDS = new Set([
  "is", "and", "the", "a", "an", "it", "only", "never", "no", "not", "may", "must",
  "or", "so", "to", "when", "which", "with", "without", "every", "this", "that",
  "then", "before", "after", "if", "but", "read", "follow", "use", "emits", "names",
  "create", "are", "its", "has", "one", "each", "per", "into", "from", "than",
]);

/**
 * Every `oflow <path>` a block instructs an agent to run.
 *
 * A path can be two words -- `oflow glab api <GET endpoint>` -- and only the
 * first word would fail to resolve, so the two-word form is checked whole.
 * The `<...>` placeholder after it is an argument, not part of the command.
 */
function commandsIn(text) {
  const found = new Set();
  for (const match of text.matchAll(/\boflow ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/g)) {
    const path = match[1];
    if (!NOT_COMMANDS.has(path.split(" ")[0])) found.add(path);
  }
  return [...found].sort();
}

test("every oflow command named in an agent instruction block exists", () => {
  const unknown = [];
  for (const [label, text] of Object.entries(BLOCKS)) {
    for (const command of commandsIn(text)) {
      let status;
      try {
        execFileSync(process.execPath, [cli, command, "--help"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        status = 0;
      } catch (error) {
        status = error.status ?? -1;
      }
      if (status !== 0) unknown.push(label + " -> oflow " + command);
    }
  }
  assert.deepEqual(unknown, [], "commands that do not resolve:\n" + unknown.join("\n"));
});

test("the instruction blocks do not name an internal function as a command", () => {
  // The specific regression: an internal helper appeared in the safety line as
  // if an agent could run it, and doing so returned "Unknown command".
  for (const [label, text] of Object.entries(BLOCKS)) {
    assert.doesNotMatch(
      text,
      /oflow (normalizeForbidden|assertIssueLabelsExist|resolveAssigneeIds|buildLabelsAudit)\b/,
      label + " names an internal function as if it were a command",
    );
  }
});

test("the safety line points at a command that exists", () => {
  assert.match(agentInstructionBlock("codex"), /oflow doctor --check-api/);
  const help = execFileSync(process.execPath, [cli, "doctor", "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(help.length > 0, "doctor --help should produce output");
});
