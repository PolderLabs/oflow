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
oflow auth login              # store a GitLab token outside the repo
oflow auth set --token-stdin  # store one from a pipe without shell history
oflow auth status             # inspect auth without displaying the token
oflow auth clear              # remove the stored token for this host
oflow doctor                  # check local setup and GitLab access prerequisites
oflow doctor --check-api      # also make a read-only GitLab API request
oflow work                    # list open GitLab issues/work items
oflow start --story 42        # remember the active story locally
oflow context --story 42     # print story, epic, MRs, pipelines, and notes
oflow mr --story 42           # print an acceptance-aware MR description
oflow verify --story 42       # check MR evidence and the latest pipeline
```

For API-backed commands, the easiest interactive setup is:

```bash
cd my-gitlab-repo
oflow auth login
oflow doctor --check-api
```

The token is entered without echoing and stored outside the repository in the
user's oflow configuration directory with owner-only file permissions.
Credentials are stored per GitLab host.
For automation, prefer an environment variable or pipe the token on stdin:

```bash
export GITLAB_TOKEN=glpat-...
# or: printf '%s' "$GITLAB_TOKEN" | oflow auth set --token-stdin
```

Environment variables take precedence over stored credentials. `oflow` also
accepts `GITLAB_ACCESS_TOKEN` and `GITLAB_PRIVATE_TOKEN`. Never put a token in
`.oflow/config.json`, `.env` committed to Git, an agent instruction file, or a
command-line argument. A read-only `read_api` token is sufficient for
`context` and `verify`; use broader write scopes only for tools that explicitly
need them.

The current release uses the GitLab REST API for deterministic read-only
context and verification. GitLab's official `glab` CLI is an optional
companion—not a replacement for the API or its permissions—and the GitLab MCP
server is an optional agent-facing path. `oflow` does not currently invoke or
configure either one: it complements them. Remote changes must be explicit and
follow `plan -> approve -> apply -> verify`; `oflow` does not create or update
GitLab issues, merge requests, comments, labels, or branches.

See [`docs/GITLAB-INTEGRATION.md`](docs/GITLAB-INTEGRATION.md) for the backend,
authentication, security, and implementation decision record.

For the NestPod self-managed GitLab instance, configure the MCP server in the
agent's user-level MCP settings (not in this repository):

```json
{
  "mcpServers": {
    "GitLab": {
      "type": "http",
      "url": "https://gitlab.fdmci.hva.nl/api/v4/mcp"
    }
  }
}
```

The exact settings location depends on the agent. The GitLab MCP client
handles its own authorization; do not copy the `oflow` token into MCP config.
The instance administrator must allow MCP access, and the MCP server is
currently a GitLab beta feature.

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

## Scrum and planning roadmap

The next product focus is Scrum/planning: work items, acceptance criteria,
labels, issue boards, milestones, epics, and group-level iterations/sprints.
See [`docs/SCRUM-PLANNING.md`](docs/SCRUM-PLANNING.md) for the agent contract
and [`docs/ROADMAP.md`](docs/ROADMAP.md) for the staged implementation plan.
The planned `oflow sync` command will gather evidence and help an agent assess
progress; it will remain read-only. Future writes will use explicit
`plan -> approve -> apply -> verify` transitions.

## License

MIT
