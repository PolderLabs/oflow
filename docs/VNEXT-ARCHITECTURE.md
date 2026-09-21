# oflow vNext Architecture — Agent Workflow Brain, OMP Compatibility, Execution Adapters, and Smart Authentication

> **Status:** Proposed architecture and implementation plan for the next major milestone.
> **Date:** 2026-09-18
> **Package:** `oflow-workflow` — CLI: `oflow`
>
> This document is the architectural source of truth for vNext. The execution
> checklist lives in [`ROADMAP.md`](ROADMAP.md) (Phase 4).

---

## 0. Architecture principle

> **oflow owns workflow semantics, evidence, policy, approval, and verification.
> GitLab MCP, `glab`, REST, and GraphQL are interchangeable execution
> mechanisms. Authentication belongs to those execution mechanisms and is
> resolved at runtime; credentials never belong to workflow artifacts.**

When evaluating a new feature, ask:

```text
Is this workflow intelligence?
    -> probably belongs in oflow.

Is this merely another way to call GitLab?
    -> prefer an existing GitLab transport.

Does oflow need the result to verify workflow state?
    -> add the smallest normalized read required.
```

---

## 1. Executive decision

`oflow` should **not** become another GitLab CLI, another GitLab SDK, or
another MCP implementation.

GitLab already provides:

- a mature REST API,
- GraphQL for newer planning/work-item features,
- the `glab` CLI,
- a hosted GitLab MCP server,
- native issue/work-item, merge-request, repository, and CI actions.

The long-term value of `oflow` is the layer **above** those transports:

> **oflow is the workflow brain between coding agents and GitLab.**

It should answer:

- What should the agent work on?
- What is the current project and sprint state?
- What user story is active?
- Which acceptance criteria are binding?
- What evidence already exists?
- Is the story stale or blocked?
- What actions are allowed?
- Which actions require approval?
- Which authenticated GitLab execution backend is available?
- Has the remote state changed since the action was planned?
- Did the resulting MR/pipeline actually prove the work?
- Is the story ready to move forward or close?
- What should the next agent know?

The transport used to perform a GitLab action is secondary.

```text
                    Claude / Codex / OMP / Copilot
                               |
                               v
                    +---------------------+
                    |        oflow        |
                    |---------------------|
                    | project contract    |
                    | work selection      |
                    | compact context     |
                    | workflow state      |
                    | acceptance evidence |
                    | policy              |
                    | approvals           |
                    | audit               |
                    +----------+----------+
                               |
                         Action Abstraction
                               |
            +------------------+------------------+
            |                  |                  |
            v                  v                  v
      GitLab MCP             glab            REST/GraphQL
      agent-owned          CLI-owned          oflow-owned
            |                  |                  |
            +------------------+------------------+
                               |
                               v
                            GitLab
```

The next major milestone is therefore **not** "wrap more GitLab endpoints".

The milestone is:

> **An agent can enter a repository, run one oflow workflow, understand the
> correct work, implement it, use any available GitLab execution backend,
> prove the acceptance criteria, and leave GitLab plus the local project state
> in a verified condition.**

---

## 2. What already exists and is preserved

The current repository has moved well beyond a thin CLI wrapper. The existing
implementation already provides:

- project installation and idempotent scaffolding,
- `AGENTS.md`, `CLAUDE.md`, `.oflow/WORKFLOW.md`,
- GitLab project/remote detection,
- host-specific authentication support,
- REST integration and bounded GraphQL integration,
- issue/work-item reads, group epic reads, iterations and cadences,
- boards and board lists, labels, milestones, current-user work,
- story context, acceptance-criteria parsing,
- merge-request evidence and pipeline evidence,
- story assessment, stale-story detection, recommendation generation,
- a local SQLite read model with offline/cached reads,
- plan artifacts, approval, apply, post-apply verification,
- stale remote-state guards, audit history,
- guarded work-item creates/updates, notes, labels, milestones, board changes,
  iteration assignment, bounded bulk changes,
- a local read-only dashboard,
- Linux and Windows CI, npm packaging/release work.

These are the parts that make `oflow` differentiated.

They should be **refactored around a clearer boundary, not thrown away**.

---

## 3. Product boundary

### 3.1 What oflow owns

#### Project workflow contract

```text
.oflow/WORKFLOW.md
.oflow/config.json
AGENTS.md managed block
CLAUDE.md managed block
host-specific managed instructions
```

The workflow contract describes:

- project conventions,
- allowed lifecycle transitions,
- Definition of Ready and Definition of Done,
- test, MR, and pipeline requirements,
- approval rules,
- how stories are selected,
- when work items can be updated or closed.

#### Work selection

```bash
oflow work --mine
oflow start
oflow start --story 42
```

`oflow` should be able to identify:

- assigned work,
- current sprint work,
- ready work,
- blocked work,
- stale work,
- work with missing acceptance criteria,
- work already in progress,
- work whose MR or pipeline is incomplete.

#### Compact context

Agents should not repeatedly download large GitLab payloads. `oflow` normalizes
GitLab planning/delivery data into a compact local read model.

#### Acceptance/evidence model

`oflow` associates acceptance criteria with explicit evidence:

- code references, tests, commits,
- MR and MR head SHA,
- pipeline and successful jobs,
- notes, manual evidence.

It must never infer that a criterion is satisfied merely because a vaguely
related file exists.

#### Workflow state

```text
backlog
ready
in_progress
implementation_complete
review
pipeline_failed
ready_to_merge
merged
verification_failed
done
blocked
```

This internal state does not replace GitLab's own labels/statuses. It is a
normalized agent-oriented interpretation of project state.

#### Policy

Examples:

```text
human approval required before merge
pipeline must be successful
MR must target main
head SHA must match verified pipeline
story cannot close before merge
remote work item must not have changed since planning
delete actions disabled
```

#### Plan -> approve -> apply -> verify

One of oflow's strongest differentiators. It remains mandatory for risky
remote mutation.

#### Audit

Store: intended action, preconditions, chosen backend, approval, execution
result, verification result, timestamps. Never store credentials.

### 3.2 What oflow should not own

Do **not** rebuild every GitLab feature. Avoid turning the project into a
complete implementation of:

repository file APIs, branches, commits, every merge-request endpoint, every
pipeline endpoint, releases, runners, deployments, variables, protected
branches, project administration, security dashboards, package registry,
memberships, webhooks, access-token administration.

Those capabilities can be performed by Git, GitLab MCP, `glab`, or direct
GitLab REST/GraphQL when necessary.

`oflow` should only implement direct GitLab API code when it provides one of
these benefits:

1. deterministic normalized reads,
2. significantly more compact agent context,
3. reliable precondition checking,
4. reliable verification,
5. functionality unavailable through an existing transport,
6. a safety boundary that cannot otherwise be enforced.

---

## 4. Backend-neutral actions

An `oflow` plan must describe **intent**, not a specific transport.

Bad:

```json
{
  "command": "PUT /api/v4/projects/123/issues/42",
  "token": "...",
  "body": {
    "labels": "In Progress"
  }
}
```

Better:

```json
{
  "schemaVersion": 2,
  "action": "work_item.update",
  "target": {
    "host": "gitlab.com",
    "projectPath": "acme/checkout",
    "iid": 42
  },
  "desiredState": {
    "addLabels": ["In Progress"]
  },
  "preconditions": {
    "updatedAt": "2026-09-18T17:04:12Z"
  },
  "requirements": {
    "capabilities": ["work-items.update"],
    "permissions": ["Work Item: Update"]
  },
  "policy": {
    "approval": "required",
    "destructive": false
  }
}
```

No backend. No token. No MCP server name. No `glab` command.

**The backend is selected when the action is executed.**

### 4.1 Action vocabulary

Introduce a small canonical action vocabulary. Do not create an abstraction
for every GitLab endpoint. Start with actions that correspond to meaningful
engineering workflow operations.

Planning actions:

```text
work_item.create
work_item.update
work_item.comment
work_item.close
work_item.reopen

work_item.assign
work_item.set_milestone
work_item.set_iteration
work_item.add_labels
work_item.remove_labels
work_item.set_parent

board.create
board_list.create

milestone.create
milestone.update

label.create
label.update
```

Delivery actions:

```text
merge_request.create
merge_request.update
merge_request.comment
merge_request.request_review
merge_request.merge

pipeline.run
pipeline.retry
pipeline.cancel

repository.branch.create
repository.commit.create
```

Direct repository-writing actions are optional because normal local Git is
usually preferable.

Local workflow actions:

```text
workflow.start
workflow.assess
workflow.plan
workflow.approve
workflow.verify
workflow.finish
workflow.handoff
```

The local workflow actions are where `oflow` should become strongest.

### 4.2 Action lifecycle

Every mutation follows the same lifecycle:

```text
intent
  |
  v
normalize
  |
  v
validate policy
  |
  v
capture remote preconditions
  |
  v
create plan
  |
  v
approval if required
  |
  v
resolve authenticated backend
  |
  v
execute
  |
  v
collect execution receipt
  |
  v
independent verification
  |
  v
refresh local read model
  |
  v
audit
```

This workflow is the same whether the actual action runs through MCP, `glab`,
REST, or GraphQL.

---

## 5. Smart authentication

Authentication is an **execution concern**, not part of the action.

The same approved action should be executable on a developer laptop, Claude
Code, Codex, OMP, VS Code/Copilot, a CI runner, or against a self-managed
GitLab installation.

Therefore:

```text
ActionPlan != Credential
ActionPlan != AuthSession
ActionPlan != Backend
```

Instead:

```text
ActionPlan
    |
    v
ExecutionResolver
    |
    +--> discover backends
    +--> discover authentication
    +--> check capabilities
    +--> check permissions where possible
    +--> choose safe backend
    |
    v
ExecutionAdapter
```

Introduce an `AuthResolver` / `GitLabSessionResolver`. Its job is not to
expose tokens. Its job is to answer:

```ts
interface GitLabAuthCandidate {
  host: string;
  source:
    | "mcp-runtime"
    | "glab"
    | "environment"
    | "oflow-store"
    | "ci-job-token";
  authenticated: boolean | "runtime-owned";
  interactive: boolean;
  backendCompatibility: string[];
  user?: string;
  notes?: string[];
}
```

Raw credentials must never enter: plan artifacts, SQLite, dashboard
responses, agent prompts, JSON command output, audit logs, or Git history.

### 5.1 Host detection

Before authentication, determine the GitLab host. Priority:

1. explicit `--host`,
2. `.oflow/config.json`,
3. current Git remote,
4. `GITLAB_HOST`,
5. existing authenticated `glab` hosts,
6. interactive choice if multiple candidates remain.

Example:

```bash
git remote get-url origin
```

```text
git@gitlab.com:acme/checkout.git
```

normalized to:

```json
{
  "host": "gitlab.com",
  "projectPath": "acme/checkout"
}
```

Self-managed remotes work the same way:

```text
git@gitlab.example.com:platform/api.git
```

becomes:

```json
{
  "host": "gitlab.example.com",
  "projectPath": "platform/api"
}
```

### 5.2 Authentication sources to auto-detect

For the resolved host, inspect these sources.

#### A. Agent-runtime GitLab MCP

Examples: OMP GitLab MCP, Claude GitLab MCP, VS Code GitLab MCP, another
MCP-compatible agent.

GitLab's hosted MCP server uses HTTP at:

```text
https://<gitlab-host>/api/v4/mcp
```

GitLab currently supports OAuth 2.0 Dynamic Client Registration for the hosted
MCP server. The agent runtime can therefore authenticate without `oflow`
handling credentials.

Important boundary:

> The MCP OAuth session belongs to the agent runtime.

`oflow` must **not** scrape OMP/Claude/Cursor OAuth caches to steal or reuse
their access token. Represent the state as:

```text
configured
runtime-owned
authentication must be verified by runtime
```

not `token = ...`.

#### B. Existing `glab` authentication

Run a bounded host-specific status check, conceptually:

```bash
glab auth status --hostname gitlab.com
```

If it succeeds:

```json
{
  "source": "glab",
  "authenticated": true,
  "host": "gitlab.com"
}
```

`oflow` can then use `glab api` as an authenticated transport without asking
the user to log in again.

Do not extract and print the token. Do not put the token into environment
variables for the agent. Let `glab` own its credentials.

This is an important change from requiring an `oflow` token for every
installation.

#### C. Environment token

Recognize standard GitLab variables:

```text
GITLAB_TOKEN
GITLAB_ACCESS_TOKEN
OAUTH_TOKEN
```

Use these for direct REST/GraphQL when present. Environment authentication is
especially appropriate for CI, containers, ephemeral environments, secret
managers, and developer shells that already inject credentials.

Environment variables take precedence over stored `oflow` credentials for the
same direct API transport. Never echo their values.

#### D. oflow-owned credential

Keep a direct credential path for users who do not want `glab`.

Preferred future storage: OS keyring / credential manager (Windows Credential
Manager, macOS Keychain, Linux Secret Service/libsecret). Fallback: user
config directory, owner-readable only, and the fallback should be clearly
reported.

Credentials remain per GitLab host and must be isolated per host:

```text
gitlab.com
gitlab.example.com
gitlab.acme.test
```

#### E. CI job token

In GitLab CI, detect:

```text
GITLAB_CI
CI_JOB_TOKEN
CI_SERVER_HOST
CI_PROJECT_PATH
```

Use the job token only for capabilities supported by that token. Never pretend
that a CI job token has the same capability as a normal PAT/OAuth session. The
capability resolver decides whether the requested action is allowed.

### 5.3 Authentication priority

There is no single universal priority because an MCP session is runtime-owned
while CLI/API credentials are process-owned.

For local `oflow` reads and verification:

```text
1. explicit environment token
2. authenticated glab transport
3. oflow credential store
4. CI job token when applicable
5. unavailable
```

Why `glab` before the oflow store? Reusing an already-authenticated official
CLI avoids asking the developer to maintain a second GitLab credential.

For agent-delegated remote mutation:

```text
1. authenticated GitLab MCP available in the active agent runtime
2. authenticated glab
3. direct REST/GraphQL using env/oflow credential
4. unavailable
```

This is a preference, not a hard rule. A capability registry can override the
priority when:

- MCP does not expose the required tool,
- the MCP feature is beta/version-dependent,
- `glab` output is insufficient for verification,
- REST provides a safer stale-write precondition,
- project policy requires a particular backend.

### 5.4 Limitation: standalone oflow cannot reuse an MCP OAuth session

This must be explicit. If OMP has authenticated to the hosted GitLab MCP
server, a separate `oflow` process must not scrape OMP's auth cache.

**OMP has GitLab MCP + `glab` is authenticated (ideal):**

```text
OMP actions        -> GitLab MCP
oflow reads        -> glab api
oflow verification -> glab api / REST-equivalent read
```

No PAT handling by oflow is necessary.

**OMP has GitLab MCP but no glab/direct credential (reduced mode):**

```text
agent executes GitLab action through MCP
oflow manages local workflow contract
oflow uses cached/local evidence
agent can provide remote results back to oflow
```

Full independent GitLab verification is unavailable until another
read-capable transport is authenticated. The CLI must report this clearly
instead of silently claiming verification.

**`glab` only (very good default):**

```text
oflow -> glab api -> GitLab
agent -> oflow CLI
```

One authentication flow. No GitLab MCP required.

**Direct token only:**

```text
oflow -> REST/GraphQL -> GitLab
```

Suitable for CI and minimal installations.

### 5.5 Authentication UX

Authentication should feel like this:

```bash
oflow install
```

Output:

```text
Detected
  repository: GitLab
  host: gitlab.com
  project: acme/checkout

Agent runtimes
  OMP:    found
  Claude: found
  Codex:  found

GitLab connectivity
  GitLab MCP in OMP: configured
  glab: installed
  glab auth: authenticated as @ada
  direct oflow token: not configured

Recommended setup
  No additional GitLab login required.
  oflow will use glab for CLI reads/verification.
  OMP may use GitLab MCP for delegated agent actions.
```

If nothing is authenticated:

```text
GitLab authentication is required.

Choose:
  [1] Sign in with glab in browser
  [2] Sign in with glab using device flow
  [3] Paste a fine-grained GitLab token securely
  [4] Use environment credentials
  [5] Continue read-only/offline
```

Non-interactive equivalents:

```bash
oflow auth login --glab
oflow auth login --token-stdin
oflow doctor --auth
```

Never require the user to understand the backend architecture just to get
started.

### 5.6 Prefer browser/device login over manual PAT copying

When `glab` is installed, use its official login experience:

```bash
glab auth login
glab auth login --web
glab auth login --device
```

This gives browser OAuth for normal desktops, device flow for
headless/remote environments, host-aware authentication, and GitLab.com plus
self-managed support. `oflow` should delegate to this experience instead of
implementing another OAuth UI immediately.

A direct PAT remains useful for CI, secret-manager driven environments,
installations where OAuth is disabled, and users who explicitly prefer
tokens.

### 5.7 Fine-grained token strategy

When direct tokens are needed, prefer GitLab fine-grained personal access
tokens when supported by the target GitLab version. The credential must be
limited to the smallest boundary and permissions necessary.

Typical planning profile:

```text
Project: Read
User: Read
Work Item: Read
Work Item: Create
Work Item: Update
Label: Read
Label: Create/Update
Merge Request: Read
Pipeline: Read
```

Add broader permissions only when a capability actually needs them. Do not
request by default:

```text
repository push
delete permissions
CI variables
runner administration
deployment administration
membership management
token administration
security administration
webhooks
global administration
```

The token cannot grant more access than the underlying GitLab user already
has.

### 5.8 New command: `oflow auth status`

One concise view:

```bash
oflow auth status
```

```text
GitLab: gitlab.com
Project: acme/checkout

AUTH SOURCES

Environment
  - no GitLab token detected

glab
  ✓ installed: 1.x
  ✓ authenticated for gitlab.com
  ✓ usable for API reads
  ✓ usable for supported mutations

oflow credential
  - not configured

Agent MCP
  ✓ OMP GitLab MCP configuration detected
  ? runtime OAuth state is owned by OMP
  hint: verify from OMP with /mcp test GitLab

Selected CLI backend
  glab

Selected agent execution preference
  GitLab MCP -> glab -> REST

No additional authentication is required for the CLI.
```

`oflow auth status --json` must contain metadata only, never credentials.

---

## 6. OMP compatibility

OMP should become a first-class supported host alongside Claude and Codex.

OMP can discover: project `.omp` configuration, `AGENTS.md`, Claude
configuration, Codex configuration, MCP servers, commands, rules, and skills.
OMP's native project config has higher discovery priority than imported
Claude/Codex configuration.

Therefore `oflow` should support OMP intentionally instead of relying on
accidental `AGENTS.md` compatibility.

### 6.1 OMP detection

`oflow install` detects OMP from several signals:

```text
omp executable in PATH
.omp/ directory exists
OMP_PROFILE is set
known OMP project config exists
```

Do not require all signals. Example internal result:

```json
{
  "host": "omp",
  "detected": true,
  "binary": true,
  "projectConfig": true,
  "profile": "default"
}
```

Never write to the user's global OMP profile during normal project
installation.

### 6.2 OMP instruction integration

OMP loads normal `AGENTS.md`, but also has a native project `.omp/AGENTS.md`
path with higher native configuration priority.

Generate a small managed bridge at `.omp/AGENTS.md`. Do **not** duplicate the
entire workflow contract:

```md
# oflow project workflow

This repository uses oflow.

Before choosing or changing GitLab work:
1. Read `.oflow/WORKFLOW.md`.
2. Run `oflow start --json` or the smallest relevant oflow command.
3. Prefer cached oflow context during repeated exploration.
4. Refresh before remote mutations.
5. Do not bypass oflow approval/policy gates for workflow-changing GitLab actions.
6. After remote actions, run the required oflow verification/refresh step.

GitLab MCP, glab, REST, and GraphQL are execution transports.
`.oflow/WORKFLOW.md` is the workflow authority.
```

Manage this with the same idempotent managed-block approach already used for
other host files. Preserve user content.

### 6.3 OMP slash commands

OMP supports project slash commands in `.omp/commands/*.md`.

`oflow install` optionally generates a few very small commands:

```text
.omp/commands/oflow-start.md
.omp/commands/oflow-status.md
.omp/commands/oflow-verify.md
.omp/commands/oflow-handoff.md
```

These are prompts/instructions, not duplicated business logic. Example
`oflow-start.md`:

```md
---
description: Start or continue the correct oflow-managed work
---

Read `.oflow/WORKFLOW.md`.

Run:

`oflow start --json`

Use the returned work item, constraints, acceptance criteria, evidence,
and policy as the authoritative workflow context.

Use available GitLab MCP tools only when the action is allowed by the
returned policy. Do not bypass an oflow approval requirement.
```

This gives OMP users `/oflow-start` instead of requiring them to remember
several CLI commands.

### 6.4 OMP skills

OMP also supports project skills in `.omp/skills/*/SKILL.md`.

Do **not** generate a large oflow skill by default. The workflow contract and
slash commands are enough initially. A future optional `oflow-agent` skill may
be useful if there is substantial reusable reasoning logic that cannot be
expressed through the CLI contract.

Avoid maintaining the same instructions in `AGENTS.md`, `CLAUDE.md`,
`.omp/AGENTS.md`, an OMP skill, OMP commands, and the README. The single
source of truth remains `.oflow/WORKFLOW.md`; everything else is a small
bridge to it.

### 6.5 OMP MCP discovery

OMP supports project MCP configuration at `.omp/mcp.json` and user-level
config under the active OMP profile. OMP can also discover MCP configuration
from other supported agent tools. `oflow` should therefore detect, not assume.

For a `gitlab.com` remote, look for MCP definitions matching:

```text
https://gitlab.com/api/v4/mcp
```

For self-managed GitLab:

```text
https://gitlab.example.com/api/v4/mcp
```

Also recognize an explicit local `glab mcp serve` configuration if present,
but treat it as experimental/version-sensitive rather than the default
recommendation.

Detection result:

```json
{
  "runtime": "omp",
  "mcp": {
    "gitlab": {
      "configured": true,
      "source": ".omp/mcp.json",
      "transport": "http",
      "runtimeAuth": "unknown"
    }
  }
}
```

Again: **configuration detected does not equal authenticated.** OMP owns the
MCP connection and OAuth state.

### 6.6 Optional OMP GitLab MCP setup

When OMP is detected, a GitLab remote is detected, no GitLab MCP config is
found, and the installation is interactive, `oflow install` may offer:

```text
GitLab MCP is not configured for OMP.

Configure project-local GitLab MCP?
  [Y] Yes
  [n] No
```

If accepted, write only non-secret config:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "GitLab": {
      "type": "http",
      "url": "https://gitlab.com/api/v4/mcp"
    }
  }
}
```

For self-managed: `https://<detected-host>/api/v4/mcp`. No token. No OAuth
secret. On first use, OMP/GitLab perform their own OAuth flow.

Rules:

- merge safely with an existing `.omp/mcp.json`,
- preserve existing servers,
- do not overwrite a differently configured `GitLab` entry; show a conflict
  instead,
- do not alter global `~/.omp/...` config,
- provide `--no-mcp` for users who do not want this,
- non-interactive install should not prompt; the explicit flag is
  `oflow install --with-gitlab-mcp`.

### 6.7 OMP profiles

OMP supports named profiles. `oflow` may detect `OMP_PROFILE` for
diagnostics, but normal project setup remains profile-independent.

Do not edit `~/.omp/agent/` or `~/.omp/profiles/<name>/` without a separate
explicit user-level command. Project-local `.omp/` works across profiles and
is therefore the correct default.

### 6.8 Agent-host compatibility model

One common contract:

```text
                   .oflow/WORKFLOW.md
                           |
         +-----------------+-----------------+
         |                 |                 |
      Claude             Codex              OMP
         |                 |                 |
   CLAUDE.md           AGENTS.md       .omp/AGENTS.md
         |                 |                 |
         +-----------------+-----------------+
                           |
                       oflow CLI
                           |
                     normalized JSON
```

Copilot/VS Code can continue using `.github/copilot-instructions.md`.

Every host receives essentially:

```text
Read the oflow contract.
Use oflow for current work/context/policy.
Use native coding capabilities for implementation.
Use an available GitLab execution transport.
Return to oflow for verification and handoff.
```

---

## 7. Execution backend registry

Refactor backend selection into an explicit capability registry:

```ts
interface ExecutionBackend {
  id: "gitlab-mcp" | "glab" | "rest" | "graphql";

  availability(ctx: ProjectContext): Promise<BackendAvailability>;

  supports(action: CanonicalAction): boolean;

  auth(ctx: ProjectContext): Promise<AuthState>;

  execute(
    action: ApprovedAction,
    ctx: ExecutionContext
  ): Promise<ExecutionReceipt>;
}
```

Each backend reports:

```json
{
  "backend": "glab",
  "available": true,
  "authenticated": true,
  "capabilities": [
    "work_item.update",
    "merge_request.create",
    "pipeline.retry"
  ]
}
```

MCP is different because the CLI may not own the runtime. Represent it as:

```json
{
  "backend": "gitlab-mcp",
  "available": "agent-runtime",
  "configured": true,
  "authenticated": "runtime-owned",
  "mode": "delegated"
}
```

### 7.1 Delegated MCP actions

Do not force `oflow` itself to become an MCP client immediately. Support
**delegated execution**:

```bash
oflow apply plan.json --delegate
```

returns:

```json
{
  "execution": "delegated",
  "backendPreference": "gitlab-mcp",
  "action": {
    "name": "merge_request.create",
    "arguments": {
      "project": "acme/checkout",
      "sourceBranch": "42-occupancy-sync",
      "targetBranch": "main",
      "title": "..."
    }
  },
  "afterExecution": {
    "command": "oflow apply .oflow/state/plans/<id>.json --receipt <receipt.json>"
  }
}
```

The agent calls its GitLab MCP tool and saves the tool response as a receipt
file:

```json
{
  "backend": "gitlab-mcp",
  "action": "merge_request.create",
  "executedAt": "2026-09-21T10:05:00Z",
  "success": true,
  "result": { "iid": 9, "web_url": "https://gitlab.example.test/team/project/-/merge_requests/9" }
}
```

`oflow apply <plan> --receipt <file>` ingests the receipt, records it on the
plan artifact (staying honest about the transport), and transitions the plan to
`applied`. A failed receipt records `apply-failed` and leaves the plan
`approved` so delegation can be retried. Then `oflow verify <plan>`
independently checks the resulting GitLab state using an authenticated read
transport when available.

This preserves the workflow boundary without requiring `oflow` to own the MCP
session. A future host adapter may make this handshake automatic.

### 7.2 Independent verification

Whenever practical:

```text
execution transport != verification evidence
```

Examples:

```text
agent writes via GitLab MCP
oflow verifies through glab API
```

or:

```text
oflow writes via REST
oflow performs a fresh independent GET
```

Verification should check actual postconditions, not merely trust a "success"
response.

For an MR:

```text
MR exists
source branch correct
target branch correct
head SHA expected
story linkage exists
pipeline belongs to same SHA
pipeline successful
```

For a work-item update:

```text
expected field changed
remote updated_at advanced
unrelated fields were not unexpectedly replaced
```

### 7.3 Backend choice visible but usually automatic

Normal users running `oflow start` should not care. Advanced diagnostics
(`oflow capabilities`, `oflow auth status`, `oflow backends`) could show:

```text
ACTION                    MCP       glab      REST
work_item.update          yes       yes       yes
merge_request.create      yes       yes       planned
pipeline.retry            yes       yes       planned
iteration.assign          maybe     api       GraphQL
```

The selected backend must be included in audit/verification metadata.

### 7.4 Backend selection scoring

Rather than hardcoding one backend globally, score candidates. Example
factors:

```text
+ authenticated
+ capability supported
+ stable structured output
+ verification available
+ least extra privilege
+ already configured
+ no additional login
+ project policy allows it
- experimental capability
- destructive action
- weak postcondition evidence
- requires token extraction
- requires credentials to enter model context
```

Pseudo-code:

```ts
const candidates = discoverBackends(action, context);

const selected = candidates
  .filter((x) => x.available)
  .filter((x) => x.authenticated || x.authMode === "runtime-owned")
  .filter((x) => x.supports(action))
  .filter((x) => policyAllows(x, action))
  .sort(scoreBackend)
  .at(0);
```

Never silently downgrade safety merely because another backend is easier.

---

## 8. Agent workflow

### 8.1 `oflow start` is the primary agent entry point

Current low-level commands remain useful, but agents should not need to
remember a ceremony:

```bash
oflow start
oflow start --story 42
oflow start --json
```

It performs the minimum necessary refresh and returns compact working context:

```json
{
  "project": {
    "path": "acme/checkout"
  },
  "iteration": {
    "title": "Sprint 3"
  },
  "work": {
    "iid": 42,
    "title": "Synchronize meeting-room occupancy",
    "parent": {
      "iid": 6,
      "title": "Meeting-room integration"
    },
    "acceptanceCriteria": [
      { "id": "AC1", "text": "Occupied state updates canonical pod state", "evidence": "missing" },
      { "id": "AC2", "text": "Vacant transition is propagated", "evidence": "missing" }
    ],
    "dependencies": {
      "blocked": false
    }
  },
  "git": {
    "branchRecommendation": "42-room-occupancy"
  },
  "policy": {
    "pipelineRequired": true,
    "humanMergeApproval": true,
    "closeAfterMerge": true
  },
  "execution": {
    "gitlabMcpConfigured": true,
    "glabAuthenticated": true,
    "preferredRemoteMutationBackend": "gitlab-mcp",
    "verificationBackend": "glab"
  }
}
```

This is the thing Claude, Codex, OMP, and future agents consume.

### 8.2 Suggested agent workflow

Start:

```bash
oflow start --json
```

The agent learns: current story, acceptance criteria, dependencies, workflow
policy, known evidence, recommended branch, GitLab execution options.

Develop — the agent uses normal engineering tools (Git, editor, tests, LSP,
compiler, local runtime). `oflow` does not need to mediate every code edit.

Check:

```bash
oflow check --json
```

Possible output:

```text
AC1  satisfied by test + code evidence
AC2  satisfied by test + code evidence
AC3  unknown

Local tests: passing
MR: missing
Pipeline: missing

Next action:
  create merge request
```

Plan remote change:

```bash
oflow plan merge-request create --story 42
```

Approve if required:

```bash
oflow approve <plan>
```

Apply — either `oflow apply <plan>` or delegated to an agent MCP runtime.

Verify:

```bash
oflow verify --plan <plan>
```

Finish:

```bash
oflow finish --story 42
```

Possible result:

```text
Implementation         ✓
Acceptance evidence    ✓
Merge request          ✓ !83
Pipeline               ✓ #812
Verified head SHA      ✓ 91f2...
Merge                  waiting for human approval
Story close            blocked by merge policy
```

### 8.3 `oflow check` unifies assessment and verification

Keep low-level commands (`context`, `assess`, `verify`, `cache status`,
`sync`) but add an agent-facing summary:

```bash
oflow check
```

It combines:

- local Git status,
- story context,
- acceptance evidence,
- MR state,
- pipeline state,
- stale remote data,
- workflow policy,
- next required action.

This reduces prompt/tool overhead.

---

## 9. Security

### 9.1 Secret handling rules

Hard rules:

1. Never serialize access tokens to plan JSON.
2. Never serialize access tokens to audit JSONL.
3. Never store tokens in SQLite.
4. Never print tokens in `--json`.
5. Never put tokens into `AGENTS.md`.
6. Never put tokens into `CLAUDE.md`.
7. Never put tokens into `.omp`.
8. Never pass a token as a normal command-line argument when
   stdin/keyring/env can be used.
9. Redact GitLab token patterns from subprocess errors.
10. Do not scrape MCP OAuth caches.
11. Do not copy a `glab` token merely to reuse it with REST when `glab api`
    can perform the request.
12. Dashboard process receives no GitLab credential.

### 9.2 Public repository safety

The existing public-content guardrails remain. Generated docs, tests, and
examples must use synthetic data. Never commit:

- private client names where inappropriate,
- employee identities,
- private hosts,
- screenshots of private GitLab,
- real project tokens,
- logs containing credentials,
- local auth configuration.

Add OMP paths to the public-content scanner as needed.

---

## 10. Repository refactor direction

The current implementation has accumulated substantial responsibility in a few
modules. Do not perform a giant rewrite; refactor around boundaries
incrementally. Suggested shape:

```text
src/
  workflow/
    start.ts
    check.ts
    finish.ts
    state.ts
    policy.ts
    evidence.ts

  actions/
    schema.ts
    planner.ts
    approval.ts
    executor.ts
    verifier.ts

  auth/
    resolver.ts
    host.ts
    env.ts
    glab.ts
    store.ts
    ci.ts

  backends/
    registry.ts
    rest.ts
    graphql.ts
    glab.ts
    delegated-mcp.ts

  hosts/
    detect.ts
    claude.ts
    codex.ts
    omp.ts
    copilot.ts

  read-model/
    ...

  gitlab/
    normalize.ts
    models.ts
    minimal-rest.ts
    minimal-graphql.ts
```

The point is not file naming. The point is to separate:

```text
workflow semantics
action semantics
authentication
execution transport
host integration
normalized GitLab models
```

### 10.1 Existing `plan.ts`

The current large plan implementation gradually becomes:

```text
actions/schema
actions/planner
actions/approval
actions/executor
actions/verifier
```

Do not keep adding every future action into one large switch statement. Each
action implements a small handler contract:

```ts
interface ActionHandler<TPlan, TResult> {
  validate(plan: TPlan): Promise<void>;
  requiredCapabilities(plan: TPlan): CapabilityRequirement[];
  verify(plan: TPlan, result: TResult): Promise<VerificationResult>;
}
```

Backend adapters implement execution. Action handlers implement semantics and
verification.

### 10.2 Existing GitLab adapter

Keep the typed GitLab adapter for:

- compact reads,
- normalization,
- verification,
- features with no good external transport,
- precondition checks.

Do not automatically add direct REST wrappers for every delivery feature.
Before implementing a new endpoint, ask:

```text
Does oflow need to understand this operation,
or merely request it and verify the outcome?
```

If it only needs to request it, `MCP/glab execution + oflow verification` is
preferable.

### 10.3 Current glab adapter

Expand `glab` from "GET-only escape hatch" into a proper authenticated
transport, but still keep safety in oflow.

Important:

```text
glab must never bypass plan -> approve -> apply -> verify
```

`glab` is execution, not policy. Possible internal methods:

```text
glabApiGet
glabExecuteAction
glabAuthStatus
glabCapabilities
```

Avoid shell-string construction. Continue using argument arrays /
`execFile`. Continue strict JSON validation and error redaction.

### 10.4 GitLab MCP adapter boundary

Do not immediately implement a full MCP client. Start with:

```text
detect configuration
describe capability
produce delegated action request
accept execution receipt
verify outcome
```

Later, host-specific integrations can directly bridge to the agent runtime.
This is much less risky than building a generic MCP stack inside v0.x.

### 10.5 OMP-specific future bridge

OMP is particularly extensible. A later `oflow` OMP extension could provide
`/oflow-start`, `/oflow-check`, `/oflow-apply` with access to the OMP runtime
and its MCP tools:

```text
OMP extension
   |
   +--> oflow CLI JSON
   |
   +--> GitLab MCP tool call
   |
   +--> oflow verify
```

This would create a near-seamless workflow without `oflow` owning the MCP
OAuth token. Do not build this until the generic CLI/action contract is
stable.

---

## 11. Installation and diagnostics

### 11.1 Authentication setup flows

**Flow A — easiest normal developer setup:** Git repository, `glab`
installed, `glab` already authenticated.

```bash
npm install -g oflow-workflow
oflow install
```

Result: no additional GitLab credentials required; oflow uses the glab
transport. This must be a first-class path.

**Flow B — OMP + GitLab MCP + glab:** OMP -> MCP for convenient agent
actions; oflow -> glab for reads and independent verification. Strong
separation.

**Flow C — OMP + hosted GitLab MCP only:** OMP -> GitLab MCP; oflow ->
local workflow/cached state. Remote independent verification is limited.
Report "verification requires an authenticated CLI read transport" and offer
"Authenticate glab?" — do not ask for a PAT first.

**Flow D — direct fine-grained PAT:**

```bash
oflow auth login --token-stdin
```

Then oflow -> REST/GraphQL. Good for servers, automation, users avoiding
glab, specific permission profiles.

**Flow E — CI:** Detect GitLab CI. Prefer the CI job token for supported
reads/actions and an explicit protected fine-grained token for anything more
privileged. Never automatically convert a job token into `GITLAB_TOKEN`.

### 11.2 `oflow doctor` improvements

Expand diagnostics into layers: `oflow doctor [--auth|--agents|--gitlab]`.

Summary target:

```text
Repository
  ✓ Git
  ✓ GitLab remote
  ✓ project detected

Agents
  ✓ OMP
  ✓ Claude
  ✓ Codex

Workflow
  ✓ .oflow/WORKFLOW.md
  ✓ managed instruction bridges

Authentication
  ✓ glab authenticated
  - direct oflow token
  ✓ OMP GitLab MCP configured
  ? OMP MCP OAuth is runtime-owned

GitLab capabilities
  ✓ project reads
  ✓ work-item reads
  ✓ MR reads
  ✓ pipeline reads
  ✓ planning writes via glab
  ✓ iteration assignment via GraphQL/direct API if direct credentials exist

Recommended
  No setup changes required.
```

Keep doctor non-mutating.

### 11.3 Installation remains idempotent

`oflow install` must safely rerun. For every generated file:

```text
if absent       -> create
if managed      -> update managed block
if user content -> preserve
if conflict     -> explain, never destroy
```

Add OMP integration to the existing test matrix.

### 11.4 Project files after OMP support

```text
.oflow/
  config.json
  WORKFLOW.md
  README.md
  templates/
    merge-request.md

.omp/
  AGENTS.md
  commands/
    oflow-start.md
    oflow-status.md
    oflow-verify.md
    oflow-handoff.md
  mcp.json              # only if explicitly configured

.github/
  copilot-instructions.md

AGENTS.md
CLAUDE.md
```

`.oflow/WORKFLOW.md` remains authoritative.

### 11.5 Do not duplicate provider configuration

OMP already discovers configuration from several ecosystems. Therefore:

- do not copy all Claude commands into OMP,
- do not copy all Codex rules into OMP,
- do not create redundant MCP entries if OMP already discovers a working
  GitLab MCP definition,
- do not create a new GitLab login merely because oflow supports one.

Detect and reuse.

### 11.6 Product UX target

The ideal first-time experience:

```bash
npm i -g oflow-workflow

cd checkout
oflow install
```

Result:

```text
oflow 0.x

Project
  ✓ GitLab remote: gitlab.com/acme/checkout
  ✓ workflow installed

Agents
  ✓ OMP
  ✓ Claude
  ✓ Codex

Authentication
  ✓ glab already authenticated
  ✓ OMP GitLab MCP configured

Created/updated
  ✓ .oflow/WORKFLOW.md
  ✓ AGENTS.md
  ✓ CLAUDE.md
  ✓ .omp/AGENTS.md
  ✓ .omp/commands/oflow-start.md
  ✓ .omp/commands/oflow-status.md
  ✓ .omp/commands/oflow-verify.md

No extra authentication required.

Start:
  oflow start
```

Then in OMP: `/oflow-start`, or simply "Continue the current work." The OMP
instruction bridge teaches the agent to call oflow.

---

## 12. Example end-to-end flow

Assume GitLab contains:

```text
Epic 4
  |
  +-- US-4.13 Dashboard shell
```

Developer opens the repository with OMP. OMP reads `.omp/AGENTS.md` ->
`.oflow/WORKFLOW.md`.

Agent executes:

```bash
oflow start --json
```

Result:

```text
US-4.13 selected
acceptance criteria loaded
no blockers
branch recommendation returned
pipeline required
human merge approval required
GitLab MCP available
glab authenticated for verification
```

Agent implements the dashboard route, HTML/CSS/JS, and tests.

Agent runs:

```bash
oflow check --json
```

Result: implementation evidence found, tests pass, MR missing.

Agent plans:

```bash
oflow plan merge-request create --story 413
```

User approves. Because OMP has GitLab MCP, oflow returns a delegated MCP
action and OMP calls GitLab MCP. MR created: `!52`.

Then:

```bash
oflow verify --plan ...
```

`oflow` uses the glab/API read transport and confirms:

```text
MR !52 exists
source branch expected
target main
head SHA expected
pipeline associated
```

Pipeline completes. Agent runs `oflow check`:

```text
Acceptance criteria   ✓
Tests                 ✓
MR                    ✓
Pipeline              ✓
Head SHA              ✓
Merge approval        waiting for human
Story close           blocked until merge
```

After human approval/merge:

```bash
oflow finish --story 413
```

`oflow` verifies the merged SHA and updates/closes the story according to
project policy.

Another agent tomorrow runs `oflow start` and sees the next correct work
item. That is the product.

---

## 13. Postponed work

Do not prioritize these until the end-to-end agent workflow is proven:

```text
full GitLab repository API
release management
deployment management
runner administration
security APIs
package APIs
membership management
full project settings
custom dashboard expansion
generic multi-provider issue trackers
Jira support
GitHub Issues support
fully generic MCP client
```

Provider portability can be preserved architecturally without implementing
additional providers today.

---

## 14. Definition of success

`oflow` is useful when this is materially better than "Claude, use GitLab MCP
and work on issue 42." Measure the difference.

A successful `oflow` workflow provides:

1. less repeated GitLab context retrieval,
2. fewer agent guesses about what to work on,
3. fewer stale-state writes,
4. fewer accidental workflow transitions,
5. deterministic acceptance criteria,
6. clearer evidence of completion,
7. backend-independent GitLab actions,
8. no credentials in model context,
9. reliable handoff between agents,
10. reproducible audit history.

### Definition of Done for vNext

Installation:

- [ ] fresh project installs with one command,
- [ ] rerunning install is safe,
- [ ] Claude detected,
- [ ] Codex detected,
- [ ] OMP detected,
- [ ] Copilot instructions supported,
- [ ] no user-authored content destroyed.

Authentication:

- [ ] GitLab host auto-detected,
- [ ] existing glab authentication reused,
- [ ] environment credentials recognized,
- [ ] direct secure credential path available,
- [ ] GitLab MCP config detected,
- [ ] runtime-owned MCP auth clearly represented,
- [ ] no token printed anywhere,
- [ ] no duplicate login required when glab already works.

Workflow:

- [ ] `oflow start` returns one compact actionable context,
- [ ] story acceptance criteria normalized,
- [ ] dependencies visible,
- [ ] project policy visible,
- [ ] preferred execution backend visible.

Mutation:

- [ ] action is backend-neutral,
- [ ] approval remains mandatory where configured,
- [ ] backend resolved at execution time,
- [ ] stale remote precondition enforced,
- [ ] execution receipt generated,
- [ ] resulting state verified.

OMP:

- [ ] `.omp/AGENTS.md` bridge works,
- [ ] `/oflow-start` works,
- [ ] existing GitLab MCP config detected,
- [ ] project-local GitLab MCP can be configured without secrets,
- [ ] OAuth remains managed by OMP/GitLab,
- [ ] OMP profile state is not accidentally modified.

End to end:

- [ ] a real project story can be selected,
- [ ] implemented by an agent,
- [ ] MR created via available execution backend,
- [ ] pipeline verified,
- [ ] human approval respected,
- [ ] story updated/closed correctly,
- [ ] second agent can continue without reconstructing the history manually.

---

## 15. Test matrix

Add tests for the combinations that matter.

Host detection:

```text
Claude only
Codex only
OMP only
Copilot only
Claude + OMP
Claude + Codex + OMP
```

Authentication:

```text
glab installed + authenticated
glab installed + unauthenticated
glab missing

GITLAB_TOKEN
GITLAB_ACCESS_TOKEN
oflow stored credential
no credential

GitLab CI job token
multiple GitLab hosts
self-managed GitLab
```

OMP:

```text
no .omp directory
existing .omp directory
existing .omp/AGENTS.md
existing .omp/mcp.json
GitLab MCP already configured
different GitLab MCP name
conflicting GitLab entry
OMP_PROFILE set
```

Safety:

```text
no token in JSON
no token in logs
no token in SQLite
no token in generated instructions
no token in error output
no mutation from doctor
no mutation from sync
no unapproved apply
stale plan refused
```

Backend resolution:

```text
MCP + glab
MCP only
glab only
REST token only
GraphQL requirement
unsupported action
authentication expired
backend returns malformed JSON
remote changed after planning
```

---

## 16. Suggested first implementation sequence

Do this in small PRs.

1. **Architecture types** — introduce `CanonicalAction`,
   `CapabilityRequirement`, `ExecutionBackend`, `ExecutionReceipt`,
   `AuthCandidate`, `AuthResolution`. No behavior change.
2. **Auth resolver** — host detection, env detection, `glab auth status`,
   existing oflow credential detection, CI detection, `auth status` output.
   Keep secrets completely opaque.
3. **glab as reusable authenticated transport** — allow core bounded GitLab
   reads to use authenticated `glab api` when there is no direct token. This
   removes unnecessary duplicate authentication.
4. **OMP detection/instructions** — OMP binary detection, `.omp` detection,
   `.omp/AGENTS.md` managed bridge, OMP tests.
5. **OMP commands** — generate `/oflow-start`, `/oflow-status`,
   `/oflow-verify`, `/oflow-handoff` as small prompt bridges.
6. **OMP GitLab MCP detection/setup** — detect `.omp/mcp.json` and the GitLab
   hosted MCP URL; offer optional safe configuration with no credentials.
7. **Backend-neutral plan v2** — migrate one existing action (for example
   `work_item.update`) from REST-specific execution to the generic action
   executor. Maintain compatibility with old plan artifacts while migrating.
8. **`oflow start`** — compose existing sync/work/context/assessment
   primitives into a single compact agent command.
9. **`oflow check`** — compose evidence, MR, pipeline, and policy state.
10. **Delegated MCP action prototype** — use one action
    (`merge_request.create`); the agent performs it through GitLab MCP;
    `oflow` verifies the result through glab/direct read transport.
11. **Dogfood** — run the complete workflow on real stories. Measure API
    calls, tokens/context size, manual GitLab interactions, workflow errors,
    handoff quality. Only then expand the delivery action set.

---

## 17. Product statement

Recommended short description:

> **oflow gives coding agents persistent project context, enforces your
> engineering workflow, and keeps GitLab synchronized through whatever
> authenticated execution backend is already available.**

Alternative:

> **A GitLab-first workflow brain for Claude, Codex, OMP, and other coding
> agents.**

Avoid: "GitLab API for AI agents." GitLab itself already provides the API and
MCP tools.

---

## 18. External implementation references

These links describe behavior this plan relies on and should be rechecked
when implementation begins because GitLab and OMP are evolving quickly.

GitLab:

- GitLab MCP server: https://docs.gitlab.com/user/model_context_protocol/mcp_server/
- GitLab CLI authentication: https://docs.gitlab.com/cli/authentication/
- Fine-grained personal access tokens: https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/
- Fine-grained REST permissions: https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/
- Fine-grained Git permissions: https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_other/

GitLab's hosted MCP server is currently documented as Beta and uses OAuth 2.0
Dynamic Client Registration when supported. `glab` supports browser OAuth,
device authentication, tokens, and CI job-token authentication. An existing
authenticated `glab` session is therefore an important credential source for
oflow to reuse rather than requiring a second login.

OMP / Oh My Pi:

- OMP repository: https://github.com/can1357/oh-my-pi
- OMP configuration discovery: https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md
- OMP MCP configuration: https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md
- OMP slash-command internals: https://github.com/can1357/oh-my-pi/blob/main/docs/slash-command-internals.md

Relevant current OMP conventions:

```text
project native config: .omp/
project native MCP:    .omp/mcp.json
project native context:.omp/AGENTS.md
project commands:      .omp/commands/*.md
project skills:        .omp/skills/*/SKILL.md
```

OMP also discovers configuration from several other coding-agent ecosystems,
which is why oflow should detect and reuse before creating duplicate
configuration.

---

## 19. Final direction

Continue the project, but narrow it.

The current repository has enough meaningful functionality to justify
`oflow`. The risk now is not that it is too small. The risk is that it
becomes a GitLab SDK + GitLab CLI + MCP implementation + planning application
+ dashboard + workflow engine all at once.

The stronger product is:

```text
                           OFLOW

                  What should happen?
                  Is it allowed?
                  What context matters?
                  What proves completion?
```

not another transport.
