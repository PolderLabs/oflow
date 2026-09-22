# GitLab integration strategy

This document records how `oflow` connects to GitLab.com and GitLab
Self-Managed/Dedicated installations. It is the decision record for REST,
`glab`, and MCP integrations.

The post-0.2.1 research and next-step sequence is maintained in
[`RESEARCH-AND-NEXT-STEPS.md`](RESEARCH-AND-NEXT-STEPS.md).

## Decision

Use a hybrid architecture, with clear ownership:

1. **GitLab REST API is the `oflow` core backend.** It is the default for
   deterministic Scrum/planning reads and, later, explicit plan/apply writes.
2. **`glab` is an optional CLI backend and diagnostic tool.** It can cover
   endpoints that `oflow` has not wrapped yet and is useful for reproducing a
   request manually. It must not become a required npm dependency.
3. **MCP is an optional agent-facing integration.** It is useful when Claude,
   Codex, or another MCP client should interact with GitLab conversationally,
   but `oflow` must not assume that an MCP server is installed or that it
   exposes every resource.

The workflow and safety rules belong to `oflow`, regardless of which backend
performs a request:

```text
agent -> oflow intent/sync/plan/approve/apply/verify
                    |
                    +-- REST adapter (default, typed and deterministic)
                    +-- glab adapter (optional fallback/diagnostics)
                    +-- MCP adapter (optional agent/runtime path)
```

The local SQLite read model and dashboard sit outside that credentialed
network boundary. `oflow sync --refresh` is the explicit refresh operation;
`oflow dashboard` reads SQLite on `127.0.0.1` and never receives a GitLab
token. Its refresh control records a local request for the CLI rather than
calling GitLab from a browser.

The current release implements the REST path for compact project-scoped read
commands, the guarded issue-update/note/label/milestone/board/board-list plans,
including existing epic association through issue `epic_id`, bounded bulk
owner/timebox planning updates, and single-story/bounded bulk iteration
assignment plans that use the GraphQL `IssueSetIteration` mutation. It also provides an explicit
read-only `oflow glab api` fallback. Group epic listing and hierarchy reads use
an explicit, bounded Work Item GraphQL path; they are not included in the
default sync because they require parent-group access and an extra request.
Board lists are currently label-backed; board-card movement uses guarded issue
label updates. This document does not claim that `oflow` silently invokes
`glab` or MCP; both remain optional integrations.

## What the four options actually provide

| Option | Best use in `oflow` | Strengths | Limits and risks |
| --- | --- | --- | --- |
| Direct REST | Core adapter for `sync`, context, verification, and future plan/apply | Stable JSON, typed response validation, precise endpoint/permission mapping, no external executable | More adapter code and pagination/version behavior for us to maintain |
| `glab` | Optional fallback, support tool, and human/agent diagnostics | Official open-source CLI; supports GitLab.com, Dedicated, and Self-Managed; detects the host from Git remotes; has commands for issues, labels, milestones, iterations, pipelines, MRs, and more; `glab api` can reach REST or GraphQL | Adds an installed-command dependency; subprocess/error/output handling; some relevant commands are experimental; arbitrary `glab api` requests can mutate GitLab if called with a write method |
| GitLab hosted MCP server | Optional tools for an MCP-capable agent | Natural language/tool interaction, OAuth-based client authorization, no custom MCP adapter for the agent | Beta; availability depends on GitLab version/instance settings and client; tool coverage and permissions are not the same as the full REST API; the CLI does not automatically gain access to an agent's MCP server |
| `glab mcp serve` | Optional local MCP experiment, not our default | Lets an MCP client launch `glab` over stdio; can expose issues, MRs, projects, pipelines, and jobs | Official docs mark it experimental and not production-ready; its documented surface is not a complete Scrum/planning API |

Sources: [GitLab CLI](https://docs.gitlab.com/cli/), [`glab api`](https://docs.gitlab.com/cli/api/), [`glab` authentication](https://docs.gitlab.com/cli/authentication/), [GitLab MCP server](https://docs.gitlab.com/user/model_context_protocol/mcp_server/), and [`glab mcp serve`](https://docs.gitlab.com/cli/mcp/serve/).

## Why `glab` does not remove the token requirement

`glab` is another client of GitLab. A personal access token still has the
permissions and project/group boundaries assigned when it was created, and the
GitLab user's role still applies. Changing the client from REST to `glab` does
not turn a read permission into a write permission.

`glab` can authenticate with OAuth, personal access tokens, or CI job tokens.
For a self-managed instance, it can store credentials in the operating-system
keyring or its global configuration and can use `GITLAB_HOST` to select the
host. Its documented token precedence is `GITLAB_TOKEN`,
`GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`, then stored credentials.

That gives us two valid local setups:

### Recommended now: `oflow` owns the PAT

```bash
cd /path/to/your-gitlab-repository
oflow auth login
oflow doctor --check-api
```

This is the current setup. The token is stored outside the repository by
`oflow`, and the REST adapter uses it. Do not duplicate it in `.oflow/`, an
agent instruction file, `.env` committed to Git, or a command-line argument.

### Optional later: user-managed `glab` credentials

If a user wants to use `glab` directly, they may authenticate it separately:

```bash
glab auth login --hostname gitlab.example.com --stdin < token.txt
glab auth status --hostname gitlab.example.com
```

The token file should be temporary and protected; never commit it. `glab`
stores credentials globally and may use the operating-system keyring. This is
convenient for interactive use, but it creates a second credential store, so
`oflow` should not silently copy tokens between the two tools.

If a future `oflow` `glab` adapter needs to call `glab`, it should:

- detect `glab` and report its version in `oflow doctor` (JSON and human output);
- pass the host explicitly or derive it from the repository remote;
- let `glab` resolve credentials from its normal environment/keyring;
- never pass a token in command-line arguments or print child-process
  environments;
- parse only documented JSON output (`glab api --output json` or `ndjson`);
- treat every non-GET request as a mutation subject to
  `plan -> approve -> apply -> verify`;
- redact tokens and authorization headers from errors and debug logs.

The first implementation should not add a hard dependency on `glab`. A missing
binary must produce a clear “optional backend unavailable” message while the
REST path continues to work.

## Authentication truth and current hardening item

Auth discovery and usable transport are different claims. The resolver may
find a configured MCP server or an authenticated `glab` session, while a core
command may still need a direct REST token. The target contract is to report
these states separately:

```text
configured -> authenticated -> readable -> mutable -> verifiable
```

MCP configuration is runtime-owned and does not prove OAuth success. A
delegated write without an independent read transport must be reported as
reduced verification, never as fully verified. The implementation roadmap
tracks routing core reads through the selected backend or refusing with a
clear reduced-mode explanation.

## Why REST is the right core for Scrum first

Our immediate goal is a reliable planning snapshot and progress assessment:
work items, descriptions and acceptance criteria, labels, boards/lists,
milestones, epics, iterations, notes, and eventually local implementation
evidence. A core adapter needs normalized models, stable JSON, pagination,
response validation, permission diagnostics, and reproducible verification.

Direct REST gives `oflow` control over those invariants. `oflow` reads GitLab's
standard `Link` and `x-*` pagination headers and keeps the existing bounded
single-page behavior; it never silently downloads an entire project. `glab api`
can issue the same requests and is valuable for gaps, but using shell output as the core
contract would make behavior depend on an external binary and its command
version. The high-level `glab work-items` command is currently documented as
experimental, which is another reason not to make it the foundation of the
Scrum read model. Group epics are the deliberate exception: GitLab's older
Epics REST collection is deprecated, so the opt-in `epic` read uses the
future-facing Work Item GraphQL API and reports unsupported/inaccessible groups
instead of treating them as empty.

Story verification uses the merge-request-scoped pipeline endpoint rather than
assuming that the newest pipeline for the local checkout belongs to the
selected MR. When the MR response includes `sha` (or `diff_refs.head_sha`),
the selected pipeline must expose the same `sha` before `verify` or `assess`
can treat a successful pipeline as evidence. If one MR cannot be selected from
the related MRs, or no pipeline matches, the result is unverified and the
report explains why. This costs one bounded MR-pipeline read for a focused
story context and prevents an unrelated branch pipeline from passing
acceptance verification. GitLab documents the [merge request pipelines
endpoint](https://docs.gitlab.com/api/merge_requests/#list-merge-request-pipelines)
and the MR head SHA fields in its [merge requests API](https://docs.gitlab.com/api/merge_requests/).

Iterations are a deliberate boundary: GitLab documents project and group REST
endpoints for listing iterations, while sprint creation is group/cadence-backed
and not exposed as a simple project REST create/update operation. `oflow` reads
them through `oflow iteration` and the compact `sync` snapshot when available.
The default `oflow iteration` request uses the project-visible endpoint; add
`--group` for the parent-group schedule when the token has group access. This
keeps ordinary sprint reads least-privilege while making group access failures
explicit. oflow does not pretend that a milestone or label mutation is an
iteration mutation. GitLab's API documents that projects do not own
iterations; they list iterations inherited from ancestor groups. See the
[project iterations API](https://docs.gitlab.com/api/iterations/) and the
[group iterations API](https://docs.gitlab.com/api/iterations/#list-all-group-iterations).

`oflow cadence` explicitly reads the parent-group iteration-cadence schedule
through one compact GraphQL request, including automatic scheduling, duration,
future-iteration count, and rollover. It is read-only and is not part of the
default `sync` request budget. Because GitLab's GraphQL API is versionless, an
older self-managed instance may report an unsupported field; oflow keeps that
failure explicit rather than silently treating a missing cadence as an empty
schedule.

Board administration follows the same boundary. GitLab's [project issue boards
API](https://docs.gitlab.com/api/boards/) supports creating/updating boards,
creating label-backed lists, and reordering lists. oflow exposes those
non-destructive operations through guarded plans, but keeps board deletion and
direct card movement out of the default capability surface. A card's workflow
state is represented by the issue labels that back the board lists, so agents
can use the existing issue update plan and verify the resulting issue state.
For focused board movement, use GitLab's `add_labels`/`remove_labels` issue
update fields so unrelated labels are preserved; use full `labels` replacement
only when the complete set is intentional. See the [Issues API](https://docs.gitlab.com/api/issues/).

The bulk planning command intentionally maps only shared issue owners and
milestone timeboxes to GitLab's documented issue update fields:
`assignee_ids`, `milestone`, and `milestone_id`. It resolves usernames while
creating the local plan, then applies and verifies each target sequentially.
Iteration assignment is not silently approximated with a milestone: GitLab's
current `PUT /projects/:id/issues/:issue_iid` documentation does not list
`iteration_id` or `iteration_title` as update attributes. For one story,
`oflow plan issue update --story <iid> --iteration <title|iid|none>` resolves
the project-visible iteration and uses the documented GraphQL
`issueSetIteration` mutation inside the same guarded plan/apply/verify flow.
The operation requires a project-visible iteration, `Project: Update` with
the `IssueSetIteration` mutation permission, and a GitLab version exposing that
GraphQL mutation. The bulk form uses the same mutation sequentially for at
most 50 issue IIDs, with per-issue stale preconditions, partial-progress
recovery, and post-apply verification. Cadence/group writes remain staged. See
the [Issues API](https://docs.gitlab.com/api/issues/),
[Iterations API](https://docs.gitlab.com/api/iterations/),
[GraphQL API](https://docs.gitlab.com/api/graphql/), and
[GraphQL fine-grained permissions](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_graphql/).

GitLab's fine-grained REST permission mapping also gives us an explicit way to
document each capability. For the current Scrum scope, start with the
smallest project/group permissions needed for the operation, rather than
switching to a broad legacy `api` token merely because a CLI can use one. See
the [fine-grained token documentation](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/),
the [REST permission mapping](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/),
and the [REST authentication documentation](https://docs.gitlab.com/api/rest/authentication/).

## Token setup and least privilege

For an interactive agent working on one project, the preferred setup is a
fine-grained personal access token with a project boundary and an expiry date.
Use this starter profile:

| Resource | Permission | Use |
| --- | --- | --- |
| `Project` | `Read` | Resolve project identity and metadata. |
| `User` | `Read` | Resolve the authenticated user for `work --mine`. |
| `Work Item` | `Read` | Read issues, notes, milestones, iterations, and planning data. |
| `Work Item` | `Create`, `Update` | Enable oflow's guarded planning writes. |
| `Label` | `Read` | Read labels and label-backed board state. |
| `Label` | `Create`, `Update` | Enable guarded label administration when needed. |
| `Merge Request` | `Read` | Read related merge-request status. |
| `Pipeline` | `Read` | Read pipeline evidence for verification. |

Use a group boundary only for capabilities that actually need it. Add
`Group: Read` and group-level `Work Item: Read` for group epics, iterations,
or cadence reads. Do not enable `Delete`, global permissions, repository push,
CI/CD administration, secrets, runners, deployments, security administration,
webhooks, integrations, or membership management for the current oflow
surface. `oflow` does not push source code, and remote writes remain behind
`plan -> approve -> apply -> verify`.

If fine-grained tokens are not available on the target GitLab instance, use a
legacy personal access token with `read_api` for read-only commands. Use the
broad `api` scope only when guarded writes are required and fine-grained
permissions cannot be used; set a short expiry and rotate it. `read_user`
alone cannot read project planning data. A project access token is suitable
for project-only automation, while a personal token is preferable when
`work --mine` must resolve a human user's assignments. Token permissions never
exceed the GitLab user's role.

Use two practical profiles when possible:

- **Read profile:** project/user/work-item/label/merge-request/pipeline reads,
  with group read permissions only for group epics, group iterations, or
  cadence data.
- **Planning-write profile:** the read profile plus Work Item create/update,
  Label create/update, Project Planning create/update, and the project update
  permission required by the GraphQL iteration-assignment mutation.

Do not grant repository push, CI/CD variables, runners, deployments, secrets,
security administration, webhooks, memberships, token management, or delete
permissions to the planning token. Fine-grained permission names and coverage
are version/tier dependent; use GitLab's [fine-grained REST permission
table](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/)
as the final authority.

Connect without putting credentials in a repository:

```bash
cd /path/to/your-gitlab-repository
oflow install
oflow auth login                         # uses the remote host when detected
oflow auth login --host gitlab.example.com # explicit host when needed
oflow doctor --check-api                 # bounded read capability matrix
oflow doctor --check-api --json           # machine-readable checks
```

`oflow` stores host-specific credentials outside the repository. For CI or
other automation, prefer an environment variable or protected stdin input;
never pass a token as a command-line argument or commit it to a file.

`doctor --check-api` probes one small page for each core REST resource and
bounded optional group/GraphQL reads. It does not follow pagination, inspect
the token's hidden scope list, or perform writes. The JSON `apiChecks` array
shows `passed`, `failed`, `skipped`, and `not-probed` states. Every write
capability is intentionally `not-probed`; test a real write only through
`plan -> approve -> apply -> verify`.

## Token creation is not normal onboarding

Fine-grained PATs are the preferred manually provisioned option when the
target GitLab version supports the required permissions. A token that can mint
other tokens is a high-privilege credential factory and is not a safe default
for an interactive planning tool. Normal onboarding should use a read or
planning-write profile, GitLab MCP OAuth, or a project/group/service-account
credential instead.

If an advanced bootstrap flow is added, it must accept the bootstrap secret
only through protected stdin/runtime secret input, display the exact scope,
boundary, and expiry, require explicit approval, verify the replacement, and
show how to revoke/remove the bootstrap token. It must never store the
bootstrap secret in `.oflow`, SQLite, Git, prompts, or OpenWolf memory.

## How MCP fits

MCP is a tool-delivery mechanism for an agent, not a replacement for the
`oflow` workflow contract. An agent can use GitLab's hosted MCP server directly
when its runtime supports it, or use the experimental `glab mcp serve` process.
Either way:

- the agent/runtime owns MCP configuration and authorization;
- the repository must not contain MCP settings or OAuth/PAT credentials;
- `oflow` should consume MCP only through an explicit adapter or runtime
  bridge, not by assuming that a shell command can call the agent's MCP tools;
- MCP availability must be probed and reported, not assumed;
- MCP-originated writes still require the same `plan -> approve -> apply ->
  verify` policy;
- prompt-injection and untrusted GitLab content remain agent safety concerns.

For a self-managed GitLab instance, the hosted server URL follows this pattern:

```text
https://gitlab.example.com/api/v4/mcp
```

Whether that URL is available depends on the GitLab instance configuration and
the MCP client. GitLab documents the server as beta and requires the instance
administrator to allow access.

## Backend selection policy

The future capability registry should choose a backend using this order:

1. Use the REST adapter when `oflow` has a typed implementation for the
   capability.
2. Use an explicitly enabled `glab` fallback only when the operation is
   supported, the binary is present, output is machine-readable, and the
   operation's safety classification is known.
3. Use an MCP path only when the agent runtime exposes the required tool and
   can return enough structured evidence for verification.
4. Otherwise report the capability as unavailable with the missing backend,
   endpoint, or permission; never guess or silently fall back to a mutation.

Every capability must expose:

- backend used and backend alternatives;
- GitLab resource and endpoint/command/tool;
- project/group/user/global boundary;
- minimum fine-grained permissions and GitLab role;
- read-only, plan-only, apply-capable, or destructive classification;
- pagination and retry behavior;
- normalized JSON output and verification evidence;
- unsupported/version-specific failure details.

## Implementation sequence

1. Keep current direct REST reads as the baseline and finish the Scrum read
   model (iteration cadences and group epic reads are explicit GraphQL reads).
2. Add backend-neutral capability metadata and optional `glab` availability
   detection without exposing credentials.
3. [x] Add a small, opt-in `glab api` bridge for endpoints not yet wrapped by
   REST, restricted to GET and strict JSON parsing.
4. Implement plan artifacts and approval before any additional `glab` or REST
   mutation; issue updates already use this path.
5. Add MCP capability discovery/bridging only where the agent runtime can
   provide stable structured results.
6. Keep merge-request reads compact and deterministic; add the bounded,
   plan-backed v0.3.0 merge-request create/update description-file slice with
   separate permissions and tests. Keep reviews, discussions, approvals,
   pipeline mutations, releases, security, and other GitLab product families
   later, each with their own contract.

## Current recommendation for a planning-focused project

Use the PAT already configured with `oflow` and the direct REST commands today:

```bash
cd /path/to/your-gitlab-repository
oflow doctor --check-api
oflow work --state opened
oflow iteration --state current --json
oflow cadence --json
oflow context --story <iid> --json
oflow verify --story <iid> --json
```

If `oflow` is not on `PATH` because you are running this repository from a
checkout, install its local executable with `npm install`, `npm run build`, and
`npm link` from the oflow checkout. The link only exposes the CLI; credentials
remain in the user-level oflow configuration directory.

Install `glab` separately only when you want its human CLI or when a future
`oflow` capability explicitly reports it as a supported fallback. Do not
replace the current token with a broader token just to use `glab`.
