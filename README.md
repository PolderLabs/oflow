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

When using a local checkout of oflow instead of a published npm package, make
the `bin` entry available as the normal `oflow` command once:

```bash
cd /path/to/agent-workflow
npm install
npm run build
npm link
oflow --help
```

`npm link` creates a user-level npm symlink to this checkout. After source
changes, rerun `npm run build`; no token or project state is copied into the
oflow repository. Without a link, `node dist/cli.js ...` remains a valid local
fallback.

It never writes tokens or user-level Claude/Codex settings. The npm package
does not bundle Claude, Codex, `glab`, or an MCP client; agent runtimes and
optional GitLab tools remain independently installed.

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
oflow work --label "Ready" --limit 20
oflow epic --limit 20          # list group epics when group access is available
oflow epic --iid 12            # inspect one epic's parent/child hierarchy
oflow iteration --state current --json # focused project-visible sprint view
oflow iteration --group --state current --json # parent-group sprint schedule
oflow cadence --json                  # parent-group cadence schedule
oflow sync --json              # compact project, Scrum, MR, and pipeline snapshot
oflow sync --epics --json      # include a bounded group-epic snapshot (opt-in)
oflow sync --label "Ready" --limit 20 --json
oflow sync --stale-days 14 --json # flag returned work items with no recent update
oflow sync --cached --json # reuse the matching local snapshot without GitLab access
oflow sync --refresh --json # explicitly fetch GitLab and replace the local snapshot
oflow assess --story 42 --json # story progress, acceptance, and local evidence
oflow capabilities --json      # show implemented, planned, and optional paths
oflow audit --json             # read local plan lifecycle history
oflow glab api <endpoint>      # optional read-only glab API fallback
oflow start --story 42        # remember the active story locally
oflow context --story 42     # print story, epic, MRs, pipelines, and notes
oflow mr --story 42           # print an acceptance-aware MR description
oflow mr --iid 8 --json       # read one compact merge-request status
oflow mr --iid 8 --full       # include the MR description when needed
oflow verify --story 42       # check MR evidence and the latest pipeline
oflow plan issue update --story 42 --labels "Ready,backend"
oflow plan issue update --story 42 --add-labels "Ready" --remove-labels "In Progress"
oflow plan issue update --story 42 --iteration "Sprint 2"
oflow plan issue update --story 42 --iteration none # clear the sprint
oflow plan assess --story 42 --assignee zakar --milestone "Sprint 1"
oflow plan issues labels --stories 17,18,23 --add-labels "Ready"
oflow plan issue update --story 42 --epic 12
oflow plan issue note --story 42 --body "Progress: API contract confirmed."
oflow plan label update --label "Ready" --color "#36A269"
oflow plan milestone update --milestone 1 --state closed
oflow plan board create --name "Product Backlog"
oflow plan board update --board 1 --name "Product Planning"
oflow plan board-list create --board 1 --label "Ready"
oflow plan board-list update --board 1 --list 2 --position 0
oflow approve .oflow/state/plans/<plan-id>.json
oflow apply .oflow/state/plans/<plan-id>.json
oflow verify --plan .oflow/state/plans/<plan-id>.json
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

The current release uses the GitLab REST API for deterministic, compact
planning snapshots and guarded Scrum writes: updating issues/work items (including
assignment by username and existing epic association),
adding issue notes, creating/updating project labels and milestones, and
creating/updating boards and label-backed board lists. Single-story and bounded
bulk iteration assignment use GitLab's guarded GraphQL `IssueSetIteration`
mutation; cadence writes are not yet enabled.
`oflow sync --json` gathers bounded project, work-item, label, milestone, board,
iteration, merge-request, and pipeline evidence without descriptions unless a
specific story is selected. The agent performs the reasoning over that data;
oflow does not require an embedded model or spend tokens generating a duplicate
summary. A live sync also stores the credential-free result in the ignored
`.oflow/cache/sync.json` file. Use `oflow sync --cached --json` for a repeated
read without a token or network request; it only accepts a snapshot with the
same project and query, and reports its source, age, and original generation
time. Use `--refresh` when current GitLab state is required. Cached snapshots
are evidence for orientation, not freshness proof before a remote write.

Group epics are an explicit opt-in because they require a group-scoped read and
an additional GraphQL request. `oflow epic` lists the current project's parent
group epics, and `oflow epic --iid <iid>` reads that epic's parent and child
hierarchy. `oflow sync --epics` adds the bounded list to the normal snapshot;
without that flag, project work items still preserve any parent/epic reference
GitLab returns and no group request is made. If the instance or token cannot
read the parent group, oflow reports a warning instead of treating the group
as empty.

Use `oflow iteration --state current --json` for a focused, low-token view of
the current project-visible sprint. GitLab iterations are group-owned, so use
`oflow iteration --group --state current --json` when the token can read the
parent group and its cadence-backed schedule. Both commands accept
`--state opened|upcoming|current|closed|all` and `--limit 1..100`; output is
compact and includes pagination metadata. The project view is the default
least-privilege path and does not require a separate group lookup.

Use `oflow cadence --json` for the compact parent-group iteration-cadence
schedule. This is one read-only GraphQL request and is intentionally separate
from `sync`, so ordinary project handoffs do not pay for group cadence data.

Use `--label`, `--milestone`, `--iteration`, `--epic`, `--assignee`, `--author`, `--search`,
`--updated-after`, and `--updated-before` with `work` or `sync` to filter issues server-side.
`--iteration` accepts a title, `none`, or `any` for read-only work/sync filters.
For a single story, `plan issue update --story <iid> --iteration <title|iid|none>`
resolves a project-visible iteration and creates a guarded GraphQL assignment
plan. It must be the only issue change in that plan. For several stories, use
`plan issues update --stories <iid,...> --iteration <title|iid|none>`; cadence/
group writes remain staged. Use
`--limit 1..100` to cap the returned work items; the default is 100 for
`work` and 50 for `sync`. `--assignee none` finds unassigned items and
`--assignee any` finds assigned items. `--epic <id|none|any>` narrows results
to one epic or its association state, and `--author <username>` narrows
results to stories created by one user. These filters reduce both API response
size and the context an agent must read.
Use `--updated-before` to inspect an older slice without making oflow decide
how many days qualifies as stale.
Use `sync --stale-days 14` when an explicit age threshold is useful; it adds an
advisory stale-work-item finding from the `updated_at` values already returned
by the issue query and makes no extra GitLab request. The threshold is opt-in
and bounded to 1..3650 days; missing or invalid timestamps are treated as
unknown.
`work --json` includes the same `query`, compact `pagination`, and
`workItemsMayBeTruncated` metadata as `sync`, alongside a compact `issues` array
containing state, labels,
assignees, timebox, dates, weight, task-checklist progress, parent, timestamps,
and links—not descriptions. Markdown output shows the effective query and
marks a result as “more may exist” when it reaches the requested limit. Use
`context --story <iid>` when the description and acceptance criteria are
needed. `sync --json` additionally includes compact pagination metadata for
work items, merge requests, pipelines, labels, milestones, boards/lists,
iterations, and opt-in epics; `hasNextPage` means the agent should narrow the
filter or deliberately request a larger limit rather than assume the snapshot
is complete.

`mr --iid <iid>` reads one project merge request without changing it. Its
default JSON/Markdown shape is compact review state (branches, labels,
assignees, reviewers, merge status, and pipeline status); add `--full` when the
description is needed for evidence review. `mr --story <iid>` remains the
acceptance-aware description template command.

`assess --story <iid> --json` adds story-level owner, timebox, and task
checklist progress to the deterministic evidence. It also reports bounded,
explicit references to matching acceptance-criterion IDs in local code/test
files as candidate evidence; those references never mark a criterion satisfied
by themselves. It recommends the smallest planning follow-up when an owner or
milestone/iteration is missing, while leaving the final status judgment to the
agent. A successfully generated assessment exits 0 even when its status is
`unknown`, `in-progress`, or `blocked`; those are findings, not CLI failures.

For `assess` and `verify`, a successful pipeline must come from the selected
merge-request pipeline endpoint. When GitLab exposes the merge request head
SHA, oflow requires the pipeline SHA to match it; an unrelated branch pipeline,
an ambiguous merge request, or a stale/mismatched SHA remains unverified.

`oflow audit --json` reads the local `.oflow/state/audit.jsonl` lifecycle log.
It records successful plan creation, approval, apply, and verification events,
plus incomplete bulk applies, without storing tokens, issue descriptions, note
bodies, or other full payloads. The file is ignored by Git and the command
never contacts GitLab, so it is a low-cost way to review what an agent or user
changed through oflow. Use `--limit 1..100` to keep the output bounded.

Use `--epic <id>` to assign an issue to an existing epic, or `--epic none` on
an update to clear the association. This uses GitLab's `epic_id` issue field;
it is available on Premium and Ultimate, and the association is verified after
apply. Group-level epic creation and broader Work Item hierarchy operations
remain roadmap work.

Use `--milestone none` on an issue update to clear its sprint/timebox
assignment; named milestones continue to use `--milestone "Sprint 1"`.

For issue labels, `--labels` replaces the complete label set. Prefer
`--add-labels` and `--remove-labels` when changing one workflow label, because
those operations preserve unrelated labels and are verified after apply. Do
not mix replacement and additive/removal label flags in one plan.

For the same bounded workflow-state change across several stories, use
`oflow plan issues labels --stories 17,18,23 --add-labels "Ready"` (or
`--remove-labels`). It validates every target while creating the local plan,
updates at most 50 issues sequentially, preserves unrelated labels, and
verifies every target after apply. Bulk operations still require the same
`approve -> apply -> verify` sequence.

For a shared Scrum owner or milestone/timebox change, use
`oflow plan issues update --stories 17,18,23 --milestone "Sprint 1"`
and/or `--assignee <username>` (`--assignee none` clears assignments). This
planning-only bulk operation validates every target, updates at most 50 issues
sequentially, and verifies the requested owner/timebox on every issue. It does
not change titles, descriptions, labels, epics, due dates, weights, or issue
state; use a single-issue plan for those fields. GitLab's current REST issue
update API does not expose iteration assignment as a supported update field,
so this command uses milestones for NestPod's Sprint 1–4 timeboxes. For a
project-visible sprint assignment across several stories, use
`oflow plan issues update --stories 17,18,23 --iteration "Sprint 2"` (or
`--iteration none` to clear it). This separate GraphQL-backed bulk plan is
capped at 50 issues, applied sequentially, and verified per issue; it cannot be
combined with owner, milestone, label, or content changes.

Bulk applies persist completed targets and an `applyError` in the approved plan
if a later target fails. Retrying after review skips targets that already
returned successfully, while stale targets still fail the `updated_at`
precondition.

Issue update plans capture the target issue's `updated_at` value when the plan
is created. Apply re-reads each guarded issue immediately before writing and
refuses with `PLAN_TARGET_CHANGED` if another user or agent changed it in the
meantime. This adds one small precondition read per target and prevents a
stale plan from silently overwriting newer planning work.

GitLab's official `glab` CLI is an optional companion for detection, diagnostics,
and read-only endpoint fallbacks—not a replacement for GitLab permissions. The
GitLab MCP server is an optional agent-facing path. `oflow` keeps its own typed
REST adapter as the predictable core and does not silently invoke or configure
MCP servers. Every remote write follows `plan -> approve -> apply -> verify`.
The current apply-capable operations are `plan issue create`, `plan issue update`
(including guarded assignment, existing epic association, and single-story
iteration assignment), `plan issue note`,
`plan label create/update`, `plan milestone create/update`, and guarded board/
board-list administration, plus bounded bulk issue-label, owner/timebox, and
iteration updates; board-card movement, cadence writes, and merge-request
writes remain roadmap work.
Board-card movement is represented by guarded issue label updates rather than a
separate unsafe card mutation. `oflow glab api` only permits an explicit GET
through glab, so it cannot bypass the write gates.

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

The current product focus is Scrum/planning: work items, acceptance criteria,
labels, issue boards, milestones, iterations, merge-request evidence, and
pipelines. See [`docs/SCRUM-PLANNING.md`](docs/SCRUM-PLANNING.md) for the agent
contract and [`docs/ROADMAP.md`](docs/ROADMAP.md) for the staged implementation
plan. `oflow sync` is the compact read-only handoff; future writes will extend
the same explicit `plan -> approve -> apply -> verify` transitions.

## License

MIT
