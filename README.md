# oflow

`oflow` is a small, GitLab-first workflow layer for Claude and Codex agents.
It gives an agent a checked-in operating contract, a repeatable way to read the
current story context, and a deterministic acceptance-criteria verification step.

The intended setup is deliberately boring:

```bash
npm install -g oflow
cd my-gitlab-repo
oflow install
```

`oflow install` detects Claude and Codex from the local environment and project
files, derives the GitLab project from `origin`, and creates only project-local
files:

```text
.oflow/
  config.json
  WORKFLOW.md
  README.md
  templates/merge-request.md
AGENTS.md       # managed instructions, preserved if it already exists
CLAUDE.md       # managed instructions when Claude is detected
```

It never writes tokens or user-level Claude/Codex settings.

## Commands

```bash
oflow install                 # scaffold the workflow into the current repo
oflow install --dry-run       # show the changes without writing them
oflow doctor                  # check local setup and GitLab access prerequisites
oflow start --story 42        # remember the active story locally
oflow context --story 42     # print story, epic, MRs, pipelines, and notes
oflow mr --story 42           # print an acceptance-aware MR description
oflow verify --story 42       # check MR evidence and the latest pipeline
```

For API-backed commands, set a project or personal token in the shell:

```bash
export GITLAB_TOKEN=glpat-...
```

The current release uses the GitLab REST API for read-only context and
verification. GitLab's official MCP server remains the preferred optional
agent-facing interface for interactive changes in Claude or Codex. A future
release will add an explicit `plan -> approve -> apply -> verify` mutation
workflow.

## Workflow contract

Stories are GitLab Issues in v0.1. Their description should contain an
`Acceptance criteria` heading with checkbox items. `oflow` preserves explicit
criterion IDs such as `AC-1` and assigns stable `AC-1`, `AC-2`, ... IDs when
they are omitted.

An MR generated from the story should include one checked item and one
non-placeholder `Evidence:` line for every criterion. Verification also
requires the latest relevant pipeline to have status `success`.

## Development

```bash
npm install
npm test
npm run typecheck
npm pack --dry-run
```

The package is intentionally dependency-light. GitLab and agent-provider
adapters can be expanded later without changing the project-local workflow
contract.

## License

MIT
