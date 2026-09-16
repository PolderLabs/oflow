# GitLab integration strategy

This document records how `oflow` should connect to GitLab, especially the
self-managed NestPod instance at `gitlab.fdmci.hva.nl`. It is the decision
record for REST, `glab`, and MCP integrations.

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

The current release implements the REST path for compact read commands, the
guarded issue-update/note/label/milestone plans, and an explicit read-only `oflow glab api`
fallback. This document does not claim that `oflow` silently invokes `glab` or
MCP; both remain optional integrations.

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
cd /path/to/nestpod-repo
oflow auth login
oflow doctor --check-api
```

This is the current setup. The token is stored outside the repository by
`oflow`, and the REST adapter uses it. Do not duplicate it in `.oflow/`, an
agent instruction file, `.env` committed to Git, or a command-line argument.

### Optional later: user-managed `glab` credentials

If a user wants to use `glab` directly, they may authenticate it separately:

```bash
glab auth login --hostname gitlab.fdmci.hva.nl --stdin < token.txt
glab auth status --hostname gitlab.fdmci.hva.nl
```

The token file should be temporary and protected; never commit it. `glab`
stores credentials globally and may use the operating-system keyring. This is
convenient for interactive use, but it creates a second credential store, so
`oflow` should not silently copy tokens between the two tools.

If a future `oflow` `glab` adapter needs to call `glab`, it should:

- detect `glab` and report its version in `oflow doctor`;
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

## Why REST is the right core for Scrum first

Our immediate goal is a reliable planning snapshot and progress assessment:
work items, descriptions and acceptance criteria, labels, boards/lists,
milestones, epics, iterations, notes, and eventually local implementation
evidence. A core adapter needs normalized models, stable JSON, pagination,
response validation, permission diagnostics, and reproducible verification.

Direct REST gives `oflow` control over those invariants. `glab api` can issue
the same requests and is valuable for gaps, but using shell output as the core
contract would make behavior depend on an external binary and its command
version. The high-level `glab work-items` command is currently documented as
experimental, which is another reason not to make it the foundation of the
Scrum read model.

Iterations are a deliberate boundary: GitLab documents project and group REST
endpoints for listing iterations, while sprint creation is group/cadence-backed
and not exposed as a simple project REST create/update operation. `oflow` reads
them when available but does not pretend that a milestone or label mutation is
an iteration mutation.

GitLab's fine-grained REST permission mapping also gives us an explicit way to
document each capability. For the current Scrum scope, start with the
smallest project/group permissions needed for the operation, rather than
switching to a broad legacy `api` token merely because a CLI can use one. See
the [fine-grained token documentation](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/),
the [REST permission mapping](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/),
and the [REST authentication documentation](https://docs.gitlab.com/api/rest/authentication/).

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

For NestPod, the hosted server URL is:

```text
https://gitlab.fdmci.hva.nl/api/v4/mcp
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
   model (group epics, iterations, and cadences remain).
2. Add backend-neutral capability metadata and optional `glab` availability
   detection without exposing credentials.
3. [x] Add a small, opt-in `glab api` bridge for endpoints not yet wrapped by
   REST, restricted to GET and strict JSON parsing.
4. Implement plan artifacts and approval before any additional `glab` or REST
   mutation; issue updates already use this path.
5. Add MCP capability discovery/bridging only where the agent runtime can
   provide stable structured results.
6. Expand into merge requests, pipelines, releases, security, and other
   GitLab product families later, each with separate permissions and tests.

## Current recommendation for NestPod

Use the PAT already configured with `oflow` and the direct REST commands today:

```bash
cd /home/zakar/projects/09-nestpod-modulaire-priveruimtes
oflow doctor --check-api
oflow work --state opened
oflow context --story <iid> --json
oflow verify --story <iid> --json
```

Install `glab` separately only when you want its human CLI or when a future
`oflow` capability explicitly reports it as a supported fallback. Do not
replace the current token with a broader token just to use `glab`.
