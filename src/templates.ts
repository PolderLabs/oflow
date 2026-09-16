import type { AgentName } from "./types.js";

export const WORKFLOW_MARKER = "OFLOW MANAGED BLOCK";

export const WORKFLOW_MARKDOWN = [
  "# oflow workflow",
  "",
  "This project uses oflow as its GitLab-first agent workflow contract.",
  "",
  "## Before starting",
  "",
  "1. Read this file, the story context, and the relevant local code.",
  "2. If no story is known, run oflow work to inspect open GitLab work items.",
  "3. Resolve the active story with oflow start --story <iid> or the branch naming convention.",
  "4. Run oflow context --story <iid> and preserve the story's acceptance criterion IDs.",
  "5. If GitLab access is missing, run oflow auth login; never put tokens in this repository.",
  "6. State the plan and identify anything ambiguous before making code changes.",
  "",
  "## While working",
  "",
  "- Treat the GitLab story and its acceptance criteria as the source of truth.",
  "- Do not silently change acceptance criteria; ask the user or record the clarification in GitLab.",
  "- Keep implementation, tests, and documentation aligned.",
  "- Keep secrets and local .oflow/state/ files out of commits.",
  "- Refresh context when the story, MR, pipeline, or user direction changes.",
  "",
  "## Before handoff",
  "",
  "1. Update the MR description with one checklist item for every AC-n criterion.",
  "2. Add concrete, non-placeholder Evidence: for every checked criterion.",
  "3. Run the relevant tests and describe their result as evidence.",
  "4. Run oflow verify --story <iid>.",
  "5. Report changed files, checks run, remaining risks, and the GitLab links.",
  "",
  "## Safety",
  "",
  "Read-only context and verification commands may run automatically. oflow does",
  "not configure or invoke MCP servers; use a configured GitLab MCP only for",
  "explicit approved mutations, which must follow plan -> approve -> apply -> verify.",
].join("\n");

export const OFLOW_README_MARKDOWN = [
  "# .oflow",
  "",
  "This directory is the project-local configuration for oflow.",
  "",
  "- config.json records the GitLab remote and detected agent mode.",
  "- WORKFLOW.md is the shared agent workflow contract.",
  "- templates/merge-request.md is the acceptance-aware MR template.",
  "- GitLab credentials live outside the repository; use oflow auth login.",
  "- oflow reads GitLab through its REST API; it does not configure or invoke MCP servers.",
  "- state/ and cache/ are local and ignored; they may contain active context.",
  "",
  "Run oflow doctor --check-api to inspect setup and API access, oflow work",
  "to list open stories, or oflow context --story <iid> for one story.",
].join("\n");

export const MERGE_REQUEST_TEMPLATE_MARKDOWN = [
  "# Summary",
  "",
  "## Story",
  "",
  "Closes #<story-iid>",
  "",
  "## Acceptance criteria verification",
  "",
  "- [ ] AC-1: <copy the exact criterion text>",
  "  Evidence: TBD",
  "",
  "<Repeat one checked item and one concrete Evidence: line for every criterion.>",
  "",
  "## Implementation notes",
  "",
  "- What changed?",
  "- What tests or other verification were run?",
  "- What remains or needs follow-up?",
].join("\n");

export function agentInstructionBlock(agent: AgentName): string {
  const name = agent === "claude" ? "Claude" : "Codex";
  return [
    "<!-- oflow instructions for " + name + " -->",
    "This repository is managed by oflow. Read .oflow/WORKFLOW.md before changing code.",
    "Use oflow work to list current stories, then use oflow context --story <iid>",
    "to load the selected story and acceptance criteria. If API access is missing,",
    "use oflow auth login; never place a token in the repository. Preserve AC-n",
    "identifiers, include Evidence: in the merge request, and run oflow verify",
    "--story <iid> before handoff.",
  ].join("\n");
}
