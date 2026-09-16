# oflow Scrum and Planning Contract

This document defines the intended Scrum and planning expansion for `oflow`.
It is the source of truth for implementation, agent instructions, tests, and
future GitLab/MCP adapters.

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

## `oflow sync` intent

`oflow sync` is the planned, read-only planning command. It should gather and
normalize:

1. The current repository, branch, and local workflow configuration.
2. The selected story or the active story inferred from local state/branch.
3. The story description, comments, labels, assignees, milestone, iteration,
   parent/child work items, and linked planning objects.
4. Relevant project and group boards, lists, labels, milestones, epics,
   iterations, and iteration cadences.
5. Local implementation evidence: changed files, tests, test results, and
   relevant documentation.
6. Existing GitLab evidence currently supported by `context` and `verify`.

It should emit both human-readable Markdown and stable `--json` output. The
JSON result is the handoff format for Claude, Codex, or another agent. Sync is
not allowed to create, update, delete, comment on, or otherwise mutate GitLab.

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

## Planned command surface

Names are provisional until implemented. Commands must expose a stable JSON
shape and a useful Markdown view.

### Read and analysis

```bash
oflow capabilities --json
oflow sync [--story <iid>] [--json]
oflow work [--state opened|closed|all] [filters]
oflow issue show --story <iid> [--json]
oflow label list [--scope project|group]
oflow board list [--scope project|group]
oflow board show <id> [--json]
oflow milestone list [--scope project|group]
oflow sprint list [--group <path>]
oflow epic list [--group <path>]
```

Existing `context` and `verify` remain supported. `sync` should eventually
compose and supersede their overlapping inspection without breaking the local
workflow contract.

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
2. Run the implemented `oflow sync` command, or today use `oflow work`,
   `oflow context --story <iid>`, and `oflow verify --story <iid>`.
3. Preserve the exact story and acceptance-criterion IDs.
4. Compare GitLab planning state with local implementation and verification
   evidence.
5. Report status, blockers, ambiguities, and the smallest next steps.
6. If a GitLab change is useful, generate a plan and show it before approval.
7. Only after explicit approval may an apply-capable adapter mutate GitLab.
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

The current release implements only direct REST reads. `glab` is an optional
external executable and must not become an npm/runtime dependency. GitLab's
hosted MCP server and `glab mcp serve` are separate integrations; the latter is
currently documented by GitLab as experimental. Neither one changes the
workflow safety rules.

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
