# oflow Roadmap

This roadmap expands `oflow` from a small GitLab context helper into a safe,
agent-friendly planning and delivery assistant. It is deliberately phased:
Scrum and planning come first; merge requests and other delivery automation
come later.

## Product direction

An agent should be able to inspect a repository and its GitLab planning state,
understand progress against user stories and acceptance criteria, recommend the
next useful work, and—only after an explicit approval—apply a small, auditable
set of changes.

The product boundary remains:

- GitLab is the only provider in this release.
- The local `.oflow/` contract is stable and provider-independent.
- Read, plan, apply, and verify are separate operations.
- REST, `glab`, and MCP are provider execution mechanisms, not separate
  workflow rules.
- The current usable milestone is compact Scrum/project reads plus guarded issue,
  note, label, milestone, and board administration; iteration and delivery
  writes remain explicitly staged.

## Integration strategy

The backend decision is intentionally hybrid:

- Direct GitLab REST is the default `oflow` core for typed, deterministic
  Scrum/planning reads and future plan/apply operations.
- `glab` is an optional official CLI fallback and diagnostic tool. It must be
  detected rather than required, and it cannot bypass token permissions.
- GitLab's hosted MCP server is an optional agent-facing path. `glab mcp
  serve` is also available in newer CLI versions, but GitLab documents it as
  experimental, so neither MCP path is the Scrum foundation.

`oflow` owns normalized models, capability metadata, plan/approval gates,
evidence, and verification. Backend-specific calls stay in adapters. See
[`GITLAB-INTEGRATION.md`](GITLAB-INTEGRATION.md) for auth, security, and the
backend selection policy.

## Status

### Phase 0 — Current foundation

- [x] Project installation and idempotent local scaffolding
- [x] Claude/Codex instruction detection and managed blocks
- [x] Host-aware GitLab token storage outside repositories
- [x] GitLab remote/project detection
- [x] Read-only work-item listing
- [x] Story context gathering
- [x] Acceptance-criteria parsing and verification
- [x] Acceptance-aware merge-request text generation
- [x] Pipeline-aware verification
- [x] Explicit MCP boundary documentation

The current CLI is read-mostly against GitLab. `sync`, `work`, `context`, and
`verify` are read-only; issue, note, label, and milestone plan paths can only
mutate after approval.

### Phase 1 — Scrum and planning read model

This is the immediate implementation focus.

- [x] Add `oflow capabilities --json` with supported, planned, and unavailable
  operations plus required token boundaries/permissions.
- [x] Detect optional `glab` without making it a hard dependency or exposing
  credentials.
- [x] Add `oflow sync` as a deterministic, read-only planning snapshot.
- [x] Expand the GitLab adapter for project planning metadata.
- [x] List and inspect project boards and board lists.
- [x] List and inspect project labels.
- [x] List and inspect project milestones.
- [x] List and inspect group epics and parent/child relationships through the
  bounded, opt-in Work Item GraphQL read path; keep epic writes separate.
- [x] Preserve parent/epic references already returned by project work-item
  reads without adding per-item API calls.
- [x] List project-visible iterations/sprints and expose an explicit parent-group
  iteration read for focused sprint views.
- [ ] Inspect iteration cadences where the GitLab version supports them.
- [x] Add bounded server-side filters for state, label, milestone, assignee,
  search, and updated time; cap work-item results with `--limit`.
- [x] Add iteration and author filters.
- [x] Add server-side epic association filters; group epic listing is available
  through the explicit GraphQL read path.
- [x] Add pagination metadata, collection response validation, retries, and
  useful unsupported endpoint errors for the compact Scrum collections.
- [x] Produce a compact JSON evidence model for project, Scrum, merge-request,
  and pipeline handoff.
- [x] Read one project merge request with compact review state and opt-in
  description output.
- [x] Add an opt-in read-only `glab api` fallback for capabilities not yet
  wrapped by the typed REST adapter, with strict JSON parsing and backend
  reporting.

### Phase 2 — Safe Scrum mutations

- [x] Define a versioned plan artifact schema.
- [x] Implement issue-update plan creation without remote writes.
- [x] Implement explicit approval with plan identity and digest checks.
- [x] Implement issue-update apply through a GitLab REST adapter.
- [ ] Permit a `glab` apply adapter only after the same plan and approval gates
  are implemented and tested.
- [x] Implement post-apply verification for issue updates.
- [ ] Add a durable audit trail beyond the plan artifact.
- [x] Update issue/work-item fields through the guarded plan path.
- [x] Create work items through guarded plans; creation is non-retryable.
- [x] Close/reopen and assign work items through guarded issue updates.
- [x] Assign/remove work items from an existing epic through guarded issue
  updates; keep group-level epic CRUD separate.
- [x] Add issue/work-item progress notes through the guarded plan path.
- [x] Create/update labels through guarded plans; keep deletion disabled.
- [x] Apply/remove labels from guarded issue planning updates.
- [x] Apply/remove labels from bulk planning workflows.
- [x] Apply shared owner and milestone/timebox changes through bounded bulk
  planning workflows; keep iteration assignment plan-only until its write API
  is version-aware.
- [x] Create/update project milestones through guarded plans; keep deletion disabled.
- [x] Create/update boards and label-backed board lists through guarded plans;
  keep deletion disabled and use issue labels for board-card movement.
- [ ] Create/update epics and broader relationships at group scope.
- [ ] Create/update iterations/cadences only after validating the target
  GitLab version and permission model.
- [ ] Make safe retries idempotent and refuse ambiguous duplicate operations.
- [ ] Keep deletion disabled by default; add it only as an explicitly gated
  capability.

### Phase 3 — Agent progress intelligence

- [ ] Compare acceptance criteria to local code/test evidence.
- [x] Collect compact local Git, MR, pipeline, and note evidence for agent reasoning.
- [x] Classify explicit evidence as satisfied, partial, blocked, or unknown.
- [ ] Detect stale stories (agents can already select an older slice with
  `--updated-before`).
- [x] Detect conflicting board-state labels.
- [x] Detect missing acceptance criteria and work items without owners or
  timeboxes when the API provides the relevant fields.
- [x] Recommend the smallest next implementation or planning action.
- [ ] Generate an approval-ready plan from those recommendations.
- [ ] Add local context caching with explicit refresh and no credentials.
- [x] Support concise Markdown and machine-readable reports suitable for Claude,
  Codex, CI jobs, and future agents.

### Phase 4 — Delivery integration (later)

Merge-request writes and delivery automation are intentionally postponed until
the Scrum model and mutation safety are stable. Merge-request and pipeline
reads are already included in the compact sync/context evidence.

- [ ] Merge-request creation, updates, discussions, and review state
- [ ] Branch and repository operations
- [ ] Pipeline inspection and controlled trigger/cancel/retry operations
- [ ] Release planning and release metadata
- [ ] Delivery evidence linked back to acceptance criteria

### Phase 5 — Broader GitLab capabilities (later and opt-in)

These resource families are possible future adapters, but they are not part of
the Scrum token or automatic agent workflow:

- CI/CD settings, jobs, artifacts, runners, variables, deployments, and
  environments
- Repository commits, branches, protected branches, and code push
- Packages, container registries, Terraform state, and dependency proxy
- Security scans, vulnerabilities, compliance, audit events, and dashboards
- Monitoring, alerts, on-call schedules, and escalation policies
- Integrations, webhooks, Jira connections, and external status checks
- Project/group settings, memberships, access tokens, and namespace changes
- Pages, wikis, snippets, designs, releases, and analytics
- GitLab Duo/AI catalog resources and other instance-level features

Each future family requires its own permissions, tests, approval rules, and
failure handling. “The API supports it” is not sufficient reason to expose it
to an agent.

## Capability design rules

Every capability must document:

1. The user-facing command and JSON output.
2. The GitLab resource and endpoint family.
3. Required project/group/user/global boundary.
4. Required fine-grained permissions and minimum GitLab role.
5. Whether it is read-only, plan-only, apply-capable, or destructive.
6. Idempotency and retry behavior.
7. Verification evidence and failure states.
8. REST, `glab`, and MCP support, including unsupported paths.
9. Unit, integration, CLI, and safety tests.

## Definition of ready for an agent

A capability is agent-ready when a fresh agent can discover it through
`oflow capabilities`, understand the required access, run a dry/read-only
operation, produce an explicit plan, obtain approval, apply it, and verify the
result without reading hidden implementation details or handling raw tokens.

## Definition of done for the roadmap

- Documentation and generated `.oflow` instructions agree.
- Read-only commands have no remote mutation side effects.
- Mutations cannot bypass plan and approval gates.
- All outputs have human and JSON forms.
- Tests cover parsing, detection, scaffolding, authorization boundaries,
  request validation, idempotency, and verification.
- `npm test`, `npm run typecheck`, and `npm pack --dry-run` pass.
