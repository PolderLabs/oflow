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
2. Project work items, with compact labels, milestone/iteration, state, and
   links. The default query is bounded to 50 items.
3. Open merge requests and current-branch pipelines, bounded to 20 and 10.
4. Project labels, active milestones, boards/lists, and project-visible
   iterations.
5. When `--story <iid>` is supplied, that story's acceptance criteria, notes
   count, merge requests, and pipelines.
6. Conservative planning-health findings for missing acceptance criteria,
   unassigned work items, and work items with neither a milestone nor an
   iteration, when the GitLab response includes those fields.

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
oflow sync --json  ->  structured evidence  ->  agent analysis and advice
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
oflow assess --story <iid> [--json]
oflow glab api <endpoint> [--json]
oflow work [--state opened|closed|all] [filters]
oflow context --story <iid> [--json]
oflow verify --story <iid> [--json]
```

Board, sprint, epic, and issue-show subcommands remain planned; label and
milestone create/update plans are implemented, while `sync` composes the
currently supported overlapping inspection without breaking the local workflow
contract.

### Explicit mutations

All remote mutations use a plan artifact:

```bash
oflow plan issue create ...
oflow plan issue update ...
oflow plan label create ...
oflow plan board update ...
oflow plan milestone create ...
oflow plan sprint create ...

oflow approve .oflow/state/plans/<plan-id>.json
oflow apply .oflow/state/plans/<plan-id>.json
oflow verify --plan .oflow/state/plans/<plan-id>.json
```

The currently implemented plan operations are issue/work-item update, issue
note creation, project label create/update, and project milestone create/update:

```bash
oflow plan issue update --story <iid> \
  --title "Updated title" \
  --labels "Ready,backend" \
  --assignee zakar \
  --due-date 2027-01-20 \
  --weight 3 \
  --state closed
oflow plan issue note --story <iid> \
  --body "Progress: API contract confirmed."
oflow plan label create --name "Ready" --color "#428BCA" \
  --description "Ready for implementation"
oflow plan label update --label "Ready" --color "#36A269"
oflow plan milestone create --title "Sprint 5" \
  --start-date 2027-01-11 --due-date 2027-01-31
oflow plan milestone update --milestone 1 --state closed
```

`--assignee` accepts one or more comma-separated GitLab usernames. Use
`--assignee none` to clear assignments. oflow resolves usernames while creating
the draft plan, stores the resulting user IDs in the digest-protected artifact,
and verifies the assignee IDs after apply. User lookup is read-only; assignment
still requires the normal `plan -> approve -> apply -> verify` sequence. GitLab
documents `assignee_ids` on issue updates and username lookup through the Users
API ([Issues API](https://docs.gitlab.com/api/issues/),
[Users API](https://docs.gitlab.com/api/users/)).

Both validate that the target exists while creating the local plan, require an
unchanged digest for approval and apply, check the current Git remote before
writing, and re-read GitLab during verification. Issue assignment resolves
usernames before the plan is written. Note creation disables automatic
request retries because repeating a non-idempotent POST could create duplicate
comments. Label creation also disables automatic retries because it is a
non-idempotent POST; label updates use the idempotent PUT endpoint. Milestone
creation also disables retries for the non-idempotent POST. Board movement,
iterations, and merge-request writes are not yet apply-capable.

`oflow assess --story <iid>` is the compact progress handoff. It combines the
story's acceptance criteria, related MR evidence, pipeline status, recent notes,
and local branch/working-tree evidence. It classifies only explicit evidence;
it does not claim that local code satisfies a criterion merely because files
changed. The agent performs the final reasoning and may then create a guarded
plan.

Project sync can read group-backed iterations. Iteration creation and editing
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
2. Run `oflow sync --json` for the compact project snapshot. Add
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
