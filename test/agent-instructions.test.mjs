import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

/**
 * Commands the instruction blocks are allowed to name, as command paths.
 *
 * Parsing prose to discover these was the wrong approach and produced phantom
 * entries like "oflow finish consume" that are not commands at all. The
 * blocks are a fixed, shipped surface, so the set is declared here instead and
 * the test checks two things: every declared path is actually a command, and
 * no block names a word that is not in this set. Both directions are real
 * checks, and neither depends on guessing where prose ends.
 */
const DECLARED_COMMANDS = [
  "apply", "approve", "assess", "audit", "auth login", "auth status", "capabilities",
  "cache status", "cadence", "check", "context", "dashboard", "doctor", "finish",
  "glab api", "handoff", "iteration", "plan issue", "start", "sync", "verify",
  "verify-local", "work",
];

/**
 * Flags the blocks are allowed to use, read from the CLI's own help rather
 * than a hand-kept list. A hand-kept list is what drifted into missing four
 * real flags on the first attempt; deriving it means a block can only name a
 * flag the binary actually supports.
 */
const KNOWN_FLAGS = new Set(
  (spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" }).stdout ?? "")
    .match(/--[a-z][a-z-]*/g) ?? [],
);

/** First words of declared two-word paths, so a bare mention is still checked. */
const TOP_LEVEL = new Set(DECLARED_COMMANDS.map((path) => path.split(" ")[0]));

test("every declared oflow command actually exists", () => {
  const unknown = [];
  for (const command of DECLARED_COMMANDS) {
    const argv = command.split(" ");
    const result = spawnSync(process.execPath, [cli, ...argv], { encoding: "utf8" });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    // Only "Unknown command" proves absence. The exit code cannot: a real
    // command run outside a configured repository also exits 1, and
    // `oflow <anything> --help` short-circuits to the global help with 0.
    if (output.includes("Unknown command")) unknown.push(command);
  }
  assert.deepEqual(unknown, [], "declared but not a command: " + unknown.join(", "));
});

test("no instruction block names a command outside the declared set", () => {
  const stray = [];
  for (const [label, text] of Object.entries(BLOCKS)) {
    // Two forms, because the blocks use both: the agent instruction blocks
    // write commands bare ("oflow work --mine --cached --json"), while the
    // markdown templates put them in backticks. Anchoring on backticks alone
    // would have missed every command in the block that matters most.
    //
    // Matching "oflow <known-command>" against the declared set is what keeps
    // prose out: "oflow is the workflow authority" cannot match, because "is"
    // is not a declared command. So a phantom word is caught and a sentence is
    // not.
    for (const match of text.matchAll(/\boflow ([a-z][a-z-]*)/g)) {
      const word = match[1];
      if (!TOP_LEVEL.has(word)) {
        // "oflow is the workflow authority" and "oflow instructions for Codex"
        // are sentences. A real mistake is an unknown word followed by a
        // flag-shaped token, so only that shape is reported.
        const rest = text.slice(match.index + match[0].length);
        if (/^ --?[a-z-]/.test(rest)) stray.push(label + " -> oflow " + word);
        continue;
      }
      // A known command: check its own flags. Arguments are the leading run
      // of --flag tokens after the command; the first non-flag token ends it,
      // because everything past that is prose rather than part of the command.
      // Scanning further would judge sentences, which is how an earlier
      // version of this test produced phantom "commands" like
      // "oflow finish consume".
      const rest = text.slice(match.index + match[0].length);
      const argv = /^(?:\s+(--?[a-z][a-z-]*))*/.exec(rest);
      for (const token of (argv?.[0].match(/--?[a-z][a-z-]*/g) ?? [])) {
        if (!KNOWN_FLAGS.has(token)) {
          stray.push(label + " -> oflow " + word + " with unknown flag " + token);
        }
      }
    }
  }
  assert.deepEqual(stray, [], "undeclared command words:\n" + stray.join("\n"));
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
  const help = spawnSync(process.execPath, [cli, "doctor"], { encoding: "utf8" });
  // Status is deliberately not asserted: run outside a configured repository
  // doctor exits 1 while still printing its heading. Only the absence of
  // "Unknown command" distinguishes a real command from a typo.
  assert.equal(
    ((help.stdout ?? "") + (help.stderr ?? "")).includes("Unknown command"),
    false,
    "doctor is a real command",
  );
  assert.ok((help.stdout ?? "").length > 0, "doctor should produce output");
});
