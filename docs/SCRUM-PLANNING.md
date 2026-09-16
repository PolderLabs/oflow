# oflow Scrum and Planning Contract

This document defines the Scrum and planning contract for `oflow`. It is the
source of truth for implementation, agent instructions, tests, and future
GitLab/MCP adapters. The implemented surface is deliberately smaller than
the complete GitLab API and is expanded only behind capability discovery and
tests.

## Goal

An agent should be able to enter a repository and answer, with evidence:

- Which story or stories are active?
- What does each user story require?
- Which acceptance criteria are complete, partial, blocked, or unknown?
- What has changed locally and remotely?
- Which work items, labels, milestones, epics, boards, and sprints are related?
- What is the smallest useful next action?

The agent must be able to propose changes to GitLab planning data, but remote
changes must remain explicit and auditable.

## `oflow sync`

`oflow sync` is the compact, read-only planning command. It gathers and
normalizes the currently supported subset:

1. The current repository, branch, and local workflow configuration.
2. Project work items, with compact parent/epic context, labels,
   milestone/iteration, state, and links. The default query is bounded to 50
   items.
3. Open merge requests and current-branch pipelines, bounded to 20 and 10.
4. Project labels, active milestones, boards/lists, and project-visible
   iterations.
   Group epics are available with the explicit `--epics` opt-in or the
   `oflow epic` command; the default snapshot does not pay for a group query.
5. When `--story <iid>` is supplied, that story's acceptance criteria, notes
   count, merge requests, and pipelines.
6. Conservative planning-health findings for missing acceptance criteria,
   unassigned work items, work items with neither a milestone nor an iteration,
   and multiple board-state labels, when the GitLab response includes those
   fields.

Use `--label`, `--milestone`, `--iteration`, `--epic`, `--assignee`, `--author`,
`--search`, `--updated-after`, or `--updated-before` with `work` or `sync` to
apply the corresponding GitLab
server-side issue filter. `--iteration` accepts a title, `none`, or `any` for
read-only work/sync filters. For a single story, use
`oflow plan issue update --story <iid> --iteration <title|iid|none>`; this
resolves a project-visible iteration and creates a guarded GraphQL assignment
plan. Use `--limit 1..100` to cap returned work items
(`50` by default for `sync`, `100` for `work`). `--assignee none` and
`--assignee any` target unassigned and assigned work respectively. `--epic
<id|none|any>` filters existing epic association, while `--author <username>`
filters by creator without a user lookup. This is the preferred way to keep
agent handoffs small on larger projects.
The JSON snapshot reports the effective query, a `pagination` object for each
bounded collection, and `workItemsMayBeTruncated` for compatibility. Each page
records the requested cap, returned count, available totals, and
`hasNextPage`, so agents can tell when a follow-up sync with a larger limit is
needed without fetching another page automatically.
`work --json` reports the same query metadata alongside a compact `issues`
array with assignment, timebox, weight, dates, parent, and task-checklist
progress. Descriptions are intentionally omitted; use `context --story <iid>`
for acceptance criteria and full story evidence. Its Markdown output also
identifies capped results. Agents should treat a `true` truncation flag as a
prompt to narrow the filters or request a larger limit before making planning
decisions.

Use `oflow sync --stale-days 14 --json` to add an advisory
`stale-work-item` planning-health finding for returned work items whose
`updated_at` is older than the explicit threshold. This reuses the issue
response, makes no extra API request, is bounded to 1..3650 days, and treats
missing or invalid timestamps as unknown rather than stale.

Live syncs also save the compact result to the ignored
`.oflow/cache/sync.json` path without credentials. Use
`oflow sync --cached --json` to read the exact same project/query snapshot
without contacting GitLab; the JSON and Markdown identify the local source,
age, and original generation time. A cache miss, invalid cache, project
mismatch, or query mismatch fails instead of silently falling back to the
network. Use `oflow sync --refresh --json` when a fresh remote snapshot is
needed. Cached evidence is useful for orientation but must not be treated as a
freshness check before a remote write.

It emits human-readable Markdown and a compact `--json` result. Descriptions
are excluded from the overall snapshot and fetched only for the selected story,
so the result is suitable for low-token agent handoff. Local implementation and
test evidence still comes from repository inspection and `oflow verify`.
Planning-health findings are advisory and only emitted when the corresponding
fields are present; missing API fields are treated as unknown rather than as
planning defects.
Sync is not allowed to create, update, delete, comment on, or otherwise mutate
GitLab.

### AI responsibility

The first implementation keeps deterministic collection in `oflow` and lets
the agent perform the reasoning. In other words:

```text
oflow sync --summary --json  ->  structured evidence  ->  agent analysis and advice
```

`oflow` must not require an embedded model credential to provide useful sync
data. A future optional AI adapter may produce a summary directly, but it must
use the same evidence schema and must never turn a read operation into a write.

### Evidence classification

For every acceptance criterion, sync should report one of:

- `satisfied`: concrete implementation and verification evidence supports it.
- `partial`: some evidence exists, but a required part is incomplete.
- `blocked`: a dependency, failing check, missing access, or explicit blocker
  prevents completion.
- `unknown`: the available data is insufficient; the agent must not guess.

Evidence must include source and detail, such as a file/test reference, a
GitLab URL, a pipeline status, or a note. Textual similarity alone is not proof
that an acceptance criterion is satisfied.

## Planning objects

The Scrum-focused provider surface is intentionally smaller than the complete
GitLab API:

| Planning object | GitLab resource | Intended operations |
| --- | --- | --- |
| Story / issue / work item | `Work Item` | list, inspect, create, update, close, assign, relate, comment |
| Acceptance criteria | Work item description | parse, preserve IDs, assess evidence, propose updates |
| Workflow labels | `Label` | list, inspect, create, update, apply, remove |
| Issue board / workboard | `Work Item` | list, inspect, create, update boards and lists |
| Milestone | `Work Item` | list, inspect, create, update, assign |
| Epic | group-level `Work Item` | list, inspect, create, update, relate |
| Sprint / iteration | group-level planning | list, inspect, create, update, assign |
| Iteration cadence | group-level planning | inspect and, when supported, create/update |

GitLab calls sprints **iterations**. Iterations and cadences belong to groups,
so project-only access cannot be assumed to be enough. The authenticated GitLab
user also needs a suitable planning role. See the [GitLab iterations
documentation](https://docs.gitlab.com/user/group/iterations/).

## Command surface

Implemented commands expose a stable JSON shape and a useful Markdown view.
The remaining GitLab resource commands are roadmap entries and must not be
assumed to exist just because the API supports them.

### Read and analysis

```bash
oflow capabilities --json
oflow sync [--story <iid>] [--json]
oflow sync --epics [--limit <n>] [--json]
oflow epic [--limit <n>] [--json]
oflow epic --iid <iid> [--json]
oflow iteration [--state opened|upcoming|current|closed|all] [--limit <n>] [--json]
oflow iteration --group [--state opened|upcoming|current|closed|all] [--limit <n>] [--json]
oflow assess --story <iid> [--json]
oflow audit [--limit <n>] [--json]
oflow glab api <endpoint> [--json]
oflow work [--state opened|closed|all] [filters]
oflow mr --iid <iid> [--full] [--json]
oflow context --story <iid> [--json]
oflow verify --story <iid> [--json]
```

`oflow iteration` defaults to the project-visible iteration endpoint, which is
the smallest read for a focused sprint view. Add `--group` to resolve the
current project's parent group and read its group iterations, including
ancestor-group iterations when GitLab exposes them. A token without group
access should use the default project view or `oflow sync`; the group form
fails clearly rather than reporting a misleading empty sprint list.

Sprint creation and issue-show subcommands remain planned. Group epic listing and
hierarchy inspection use the version-aware Work Item GraphQL API. Board and
board-list administration is implemented through guarded plans, while `sync`
composes the currently supported overlapping inspection without breaking the
local workflow contract.

### Explicit mutations

All remote mutations use a plan artifact:

```bash
oflow plan issue create ...
oflow plan issue update ...
oflow plan issue update --story <iid> --iteration <title|iid|none>
oflow plan issues labels --stories <iid,...> ...
oflow plan label create ...
oflow plan board create ...
oflow plan board update ...
oflow plan board-list create ...
oflow plan board-list update ...
oflow plan milestone create ...

oflow approve .oflow/state/plans/<plan-id>.json
oflow apply .oflow/state/plans/<plan-id>.json
oflow verify --plan .oflow/state/plans/<plan-id>.json
```

The currently implemented plan operations are issue/work-item create and update,
single-story and bounded bulk iteration assignment, issue note creation, project
label create/update, project milestone create/update, board/board-list
administration, and bounded bulk label and owner/timebox updates:

```bash
oflow plan issue create \
  --title "Reserve a pod" \
  --description "Acceptance criteria:\n- [ ] AC-1: Reservation persists" \
  --labels "User Story,Ready" \
  --assignee zakar \
  --milestone "Sprint 5" \
  --due-date 2027-01-20 \
  --weight 3
oflow plan issue update --story <iid> \
  --title "Updated title" \
  --labels "Ready,backend" \
  --epic 12 \
  --assignee zakar \
  --due-date 2027-01-20 \
  --weight 3 \
  --state closed
oflow plan issue update --story <iid> \
  --add-labels "Ready" --remove-labels "In Progress"
oflow plan issue update --story <iid> --iteration "Sprint 2"
oflow plan issues labels --stories <iid>,<iid>,<iid> \
  --add-labels "Ready" --remove-labels "In Progress"
oflow plan issues update --stories <iid>,<iid>,<iid> \
  --milestone "Sprint 1" --assignee zakar
oflow plan issue note --story <iid> \
  --body "Progress: API contract confirmed."
oflow plan label create --name "Ready" --color "#428BCA" \
  --description "Ready for implementation"
oflow plan label update --label "Ready" --color "#36A269"
oflow plan milestone create --title "Sprint 5" \
  --start-date 2027-01-11 --due-date 2027-01-31
oflow plan milestone update --milestone 1 --state closed
oflow plan board create --name "Product Backlog"
oflow plan board update --board 1 --name "Product Planning"
oflow plan board-list create --board 1 --label "Ready"
oflow plan board-list update --board 1 --list 2 --position 0
```

`--assignee` accepts one or more comma-separated GitLab usernames. Use
`--assignee none` to clear assignments. oflow resolves usernames while creating
the draft plan, stores the resulting user IDs in the digest-protected artifact,
and verifies the assignee IDs after apply. User lookup is read-only; assignment
still requires the normal `plan -> approve -> apply -> verify` sequence. GitLab
documents `assignee_ids` on issue updates and username lookup through the Users
API ([Issues API](https://docs.gitlab.com/api/issues/),
[Users API](https://docs.gitlab.com/api/users/)).

For a single story, assign or clear a sprint with
`oflow plan issue update --story <iid> --iteration <title|iid|none>`. oflow
resolves the project-visible iteration during draft creation, stores its
GraphQL global ID plus human-readable IID/title in the digest-protected plan,
and verifies the resulting REST issue iteration after apply. This is a
single-field plan so the approval is easy to review; it does not combine an
iteration mutation with labels, ownership, milestone, or story-content edits.
For several stories, use
`oflow plan issues update --stories <iid,...> --iteration <title|iid|none>`.
The bounded bulk form resolves one project-visible target, captures each
issue's `updated_at`, applies sequentially, persists partial progress, and
verifies every issue.

Use `--epic <id>` on issue create/update to associate a work item with an
existing epic, or `--epic none` on update to clear it. GitLab documents
`epic_id` for both project issue creation and updates; it is a Premium and
Ultimate feature. oflow verifies the returned epic/parent ID after apply.
Creating or editing group epics themselves remains a separate, version-aware
roadmap item because GitLab's older Epics REST collection is deprecated.

Use `--milestone none` on an issue update to remove its sprint/timebox
assignment. Named milestone titles continue to use `--milestone "Sprint 1"`;
oflow maps the clear operation to GitLab's `milestone_id=0` field and verifies
that the issue no longer reports a milestone.

`--labels` replaces the full issue label set. For board movement or a focused
workflow-state change, prefer `--add-labels` and `--remove-labels`; GitLab
preserves other labels and oflow verifies that additions are present and
removals are absent. Replacement cannot be mixed with additive/removal flags,
and one label cannot be added and removed in the same plan.

For a focused workflow-state change across multiple stories, use
`plan issues labels --stories <iid,...>`. The command accepts additive and/or
removal changes only, validates every issue before writing the plan, and caps a
single plan at 50 issue IIDs. Apply is sequential so a partial failure leaves a
reusable approved plan; repeating an additive/removal update is safe for the
label operation itself, and verification checks every requested target. It does
not replace complete label sets or change titles, descriptions, assignees,
milestones, epics, or other issue fields.

For a shared owner or milestone/timebox change across multiple stories, use
`plan issues update --stories <iid,...> --assignee <username>` and/or
`--milestone <title>`. Use `--assignee none` or `--milestone none` to clear the
corresponding assignment. This command is deliberately limited to those two
planning fields, validates every target before the plan is written, caps a
plan at 50 issue IIDs, applies sequentially, and verifies every target. It is
not atomic: if an apply request fails, already-updated issues remain changed
and the approved plan identifies the target set for follow-up. For iteration
assignment, use the separate GraphQL command described above; it does not
approximate a sprint with a milestone or rely on undocumented REST issue update
fields.

Issue update plans also capture each target's `updated_at` during preflight.
Apply re-reads the target immediately before a guarded write and refuses with
`PLAN_TARGET_CHANGED` when the remote issue has changed since plan creation.
Bulk issue plans do this per target, so a stale item stops the sequential apply
before that item is written; earlier successful items remain changed and are
reported by the approved plan. Older plan artifacts without this precondition
remain readable for compatibility.

Bulk applies persist completed targets and an `applyError` in the approved plan
if a later target fails. Retrying after review skips targets that already
returned successfully, while stale targets still fail the `updated_at`
precondition. The audit log records this as `apply-failed` without copying the
request payload.

Both validate that the target exists while creating the local plan, require an
unchanged digest for approval and apply, check the current Git remote before
writing, and re-read GitLab during verification. Issue creation is a
non-idempotent POST and therefore is never automatically retried. Issue
assignment resolves
usernames before the plan is written. Note creation disables automatic
request retries because repeating a non-idempotent POST could create duplicate
comments. Label creation also disables automatic retries because it is a
non-idempotent POST; label updates use the idempotent PUT endpoint. Milestone
creation also disables retries for the non-idempotent POST. Board creation and
board-list creation likewise disable retries; board updates and list reordering
use idempotent PUT requests. Board-card movement is represented by guarded issue
label updates, not an unverified board-card mutation. Board deletion, cadence
writes, and merge-request writes are not yet apply-capable. The supported
board endpoint behavior is documented by GitLab's [project issue boards
API](https://docs.gitlab.com/api/boards/).

`oflow assess --story <iid>` is the compact progress handoff. It combines the
story's acceptance criteria, owner/timebox/task progress, related MR evidence,
pipeline status, recent notes, and local branch/working-tree evidence. It also
recommends assigning an owner and milestone/iteration when those fields are
missing. It classifies only explicit evidence;
it reports bounded local code/test references when an exact acceptance-criterion
ID is present, but does not claim that local code satisfies a criterion merely
because a file changed or contains a reference. The agent performs the final
reasoning. A generated assessment exits successfully even when its status is
`unknown`, `in-progress`, or `blocked`; those are report findings. For
`assess` and `verify`, pipeline evidence is read from the selected
merge-request pipeline endpoint and, when available, must match the merge
request head SHA; branch pipelines cannot substitute for it. When the owner and/or
milestone decision is known, `oflow plan assess --story <iid> --assignee
<username> --milestone <title>` turns that assessment into a digest-protected
issue-update plan. The command never invents planning values, only supports
owner/timebox changes, records the assessment status and recommendations in
the plan, and still requires `approve`, `apply`, and `verify`. Use `none` to
explicitly clear an owner, milestone, or single-story iteration. Bulk iteration
assignment uses the separate guarded GraphQL plan described above. Cadence
writes remain staged.

`oflow audit --json` is a local-only, bounded read of the plan lifecycle audit
log. Successful `created`, `approved`, `applied`, and `verified` transitions,
and incomplete bulk applies as `apply-failed`, are appended to
`.oflow/state/audit.jsonl`. Entries contain the operation kind,
target, changed field names, counts, and verification outcome, but not tokens,
issue descriptions, note bodies, or full request payloads. The command makes
no GitLab request and is useful for reviewing agent activity without spending
API or model context budget. Use `--limit 1..100`; newest events are returned
first and `mayBeTruncated` signals that older entries were omitted.

Project sync preserves parent/epic references when GitLab includes them on the
work-item response, without issuing a second request per story. `oflow epic`
and `oflow sync --epics` enumerate group epics through the Work Item GraphQL
API, which is the future-facing replacement for GitLab's deprecated Epics REST
collection. These reads are bounded and explicit because group access may not
be available for every project token. Project sync can read group-backed
iterations. Iteration creation and editing
remain planned because GitLab documents the project/group REST endpoints as
listing APIs; sprint creation is tied to group iteration cadences and is not a
simple project REST mutation. Do not simulate it by changing labels or
milestones.

The exact syntax may change, but the state transition must not:

```text
draft -> approved -> applied -> verified
```

`apply` must refuse a draft, stale, malformed, or already-applied plan unless
the plan explicitly supports a safe retry. It must report each operation,
result, remote identifier, and error. Deletes require a separate explicit
permission and confirmation path; they are not part of the default planning
flow.

## Sync-to-action workflow

When an agent is asked to “sync oflow”, “check progress”, or “see where we are”:

1. Read `AGENTS.md`, `README.md`, `.oflow/WORKFLOW.md`, and relevant local code.
2. Run `oflow sync --summary --json` for the token-light project overview. Use
   `oflow sync --json` when the full bounded planning collections are needed.
   Add
   `--story <iid>` when assessing one story, then use `oflow context` and
   `oflow verify` for detailed acceptance evidence.
3. Preserve the exact story and acceptance-criterion IDs.
4. Compare GitLab planning state with local implementation and verification
   evidence.
5. Report status, blockers, ambiguities, and the smallest next steps.
6. If a GitLab issue change is useful, generate a plan and show it before
   approval. Use `oflow capabilities --json` before selecting a mutation.
7. Only after explicit approval may the REST adapter mutate GitLab.
8. Re-run sync/verification and report the resulting GitLab links and evidence.

An agent may reason and recommend automatically. It must not silently update a
story, move a card, change a sprint, create labels, or alter acceptance
criteria.

## Adapter, REST, `glab`, and MCP boundary

`oflow` owns the local contract, plan schema, safety checks, evidence model,
and verification. Provider-specific API calls belong in a GitLab adapter.

The adapter may eventually have three execution paths:

```text
oflow plan/apply
       |
       +-- GitLab REST adapter (default, typed and deterministic)
       +-- glab adapter (optional fallback/diagnostics)
       +-- GitLab MCP adapter (when exposed by the agent runtime)
```

The current release implements direct REST reads plus guarded REST issue update
and note plans. It also exposes an explicit `oflow glab api` GET-only escape
hatch for endpoints not yet wrapped by REST. `glab` is detected as an optional
external executable but is not required and must not become an npm/runtime
dependency. GitLab's hosted MCP
server and `glab mcp serve` are separate integrations; the latter is currently
documented by GitLab as experimental. Neither one changes the workflow safety
rules or is silently invoked by `oflow`.

MCP configuration and authorization belong to the agent/runtime user
configuration, never to the repository. `oflow` must not assume that an MCP
server is installed or that every MCP exposes every GitLab resource. Capability
discovery, backend reporting, and clear unsupported-operation errors are
required. See [`GITLAB-INTEGRATION.md`](GITLAB-INTEGRATION.md) for the complete
decision record.

## Token requirements

For the Scrum planning surface, start with a fine-grained personal token scoped
to the NestPod project and, when required, its parent group:

- `Project`: `Read`
- `Group`: `Read`
- `Work Item`: `Read`, `Create`, `Update`
- `Label`: `Read`, `Create`, `Update`

Group epic reads additionally need access to the parent group and its Work Item
resources. If `oflow sync --epics` reports that the group is unavailable, the
project token can still support all project-scoped reads; add the parent-group
`Group: Read` and `Work Item: Read` permissions only when epic hierarchy data is
needed.

Do not grant `Delete` until deletion is deliberately implemented and tested.
Merge requests, pipelines, releases, repository writes, security, CI/CD
administration, secrets, runners, webhooks, integrations, and user/group
membership are later roadmap areas, not prerequisites for Scrum planning.

Token permissions do not replace the GitLab user's actual group/project role.
Fine-grained permission mappings are maintained in the [GitLab REST API
permission table](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/).

## Non-goals for the Scrum phase

- Do not mirror every GitLab endpoint into a thin CLI wrapper.
- Do not let `work`, `context`, `verify`, or `sync` write remotely.
- Do not place tokens, MCP configuration, model credentials, or agent state in
  the repository.
- Do not infer completion from issue text without implementation evidence.
- Do not silently rewrite user-authored descriptions or acceptance criteria.
- Do not expand project scope or mutate unrelated groups/projects.
