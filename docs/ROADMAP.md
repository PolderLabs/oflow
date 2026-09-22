# oflow Roadmap

This roadmap expands `oflow` from a small GitLab context helper into a safe,
agent-friendly planning and delivery assistant. It is deliberately phased:
Scrum and planning come first; merge requests and other delivery automation
come later.

The vNext milestone — backend-neutral actions, smart authentication, OMP
support, delegated GitLab MCP actions, and the `start`/`check`/`finish`/
`handoff` agent lifecycle — is specified in
[`VNEXT-ARCHITECTURE.md`](VNEXT-ARCHITECTURE.md) and tracked here as Phase 4;
its core is delivered. Remaining Phase 4 work is agent-runtime validation and
the deferred delivery capabilities.

The post-release research, identity/token decisions, native plugin direction,
and cross-project OpenWolf boundary are recorded in
[`RESEARCH-AND-NEXT-STEPS.md`](RESEARCH-AND-NEXT-STEPS.md). That document is
the durable decision record for the next implementation pass.

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
- The current usable milestone is compact Scrum/project reads, guarded issue,
  note, label, milestone, board, and bulk iteration administration, delegated
  merge-request creation through GitLab MCP actions, and the
  `start`/`check`/`finish`/`handoff` agent lifecycle; broader delivery writes
  remain explicitly staged.

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

## Post-0.2.1 reconciliation

The current release is a reliable foundation, not complete GitLab Scrum
coverage. The next milestone is reliability before breadth:

1. make configured/authenticated/readable/mutable/verifiable transport states
   honest and make core reads use the resolved backend or report reduced mode;
2. add first-class GitLab identity and make `work --mine` ID/server based;
3. make capabilities and doctor reflect live backend/permission availability;
4. reconcile the generated OMP/Codex/Claude contracts and validate them with
   the OpenWolf context/handoff fixture;
5. close the session-friction requirements, including the bounded plan-backed
   MR create/update slice and verification policy;
6. then package the thin native Codex/OMP integrations before expanding
   hierarchy, cadence, or broader delivery writes.

Do not make token minting a normal setup requirement. Any future credential-
minting flow is opt-in, short-lived, explicitly scoped, tested, and followed
by explicit bootstrap-token revocation instructions.

## Next release target — v0.3.0

The recommended next release is a reliability and agent-integration release,
not an attempt to wrap every GitLab endpoint. The detailed execution plan is
kept in the local OMX plan artifact at `.omx/plans/next-release-0.3.0.md`.

### Must ship

- [ ] Make transport state truthful: distinguish configured, authenticated,
  readable, mutable, and verifiable for REST, `glab`, and runtime-owned MCP.
- [ ] Route core reads through a proven backend or return explicit reduced-mode
  results; remove aggregate-auth false positives.
- [ ] Add first-class GitLab identity (`oflow identity --json`) and make
  `work --mine` use the resolved server identity rather than a guess.
- [ ] Make `capabilities --json` and `doctor` report live availability,
  permissions, implementation support, and runtime-owned state without write
  probes.
- [ ] Reconcile generated Claude, Codex, OMP, Copilot/VS Code, and OpenWolf
  contracts with the actual JSON commands and approval gates.
- [ ] Audit REST, `glab`, and delegated field parity for labels, epic links,
  dates, weight, and milestone identifiers.
- [ ] Add synthetic compatibility fixtures and release gates for all supported
  host/transport combinations; never use real credentials in fixtures.

### Mandatory session-friction closure

The following items came from an actual near-miss and repeated agent
operability friction. They are all part of v0.3.0, not optional backlog. The
implementation order is impact-first: lifecycle safety, capability truth,
delivery writes, verification flexibility, discoverability, then ergonomics.

#### F1 — Plan lifecycle hygiene and apply safety

- [x] Add plan `sessionId`/created-at expiry metadata and a documented TTL for
  draft and approved plans. *(Implemented: `PLAN_TTL_MS` in `src/plan.ts`,
  stamped by every `createXxxPlan` factory, included in `planDigest`,
  rendered in `formatPlanMarkdown`.  24h default.)*
- [x] Refuse expired or cross-session `approve`/`apply` by default; require an
  explicit, visibly dangerous `--force` path with a fresh target re-check.
  *(Implemented: `assertPlanLifecycle` in `src/plan.ts`; CLI accepts
  `--force` on `approve`/`apply` only and prints a stderr warning;
  force re-asserts host/path binding then re-runs
  `recheckPlanTarget`.  Unsupported rechecks raise
  `PLAN_RECHECK_UNSUPPORTED`.  `verify` is unaffected.)*
- [x] Add `oflow plan list` with state, age, target, operation, and expiry
  information, plus `oflow plan discard <id>` for safe local cleanup.
  *(Implemented: `listPlans` + `discardPlan` in `src/plan.ts`,
  exposed as `plan list` and `plan discard <id>` in `src/cli.ts`; rejects
  symlinked plan directory and file via `realpath` + `lstat`, refuses any
  plan with non-empty `result`/`execution`/`delegatedReceipt`/`applyError`
  or any audit event beyond `created`/`approved`; audits `discarded`.)*
- [x] Make every pre-apply output show the target IID, current title, project,
  operation, and a human-readable field diff before the remote write.
  *(Implemented: `loadApplySnapshot` + `formatApplyPreviewMarkdown` in
  `src/plan.ts`; `formatPlanMarkdown` renders the preview block.  JSON
  output exposes `plan.preview` with operation, host/project, IID, current
  title, and the per-field before/after diff.  Single live read keeps the
  preview and the no-op verdict coherent.)*
- [x] Detect equivalent current state before applying; report a verified
  `no-op` (for example `milestone_id: 0` when the milestone is already null)
  instead of recording a misleading applied mutation.
  *(Implemented: `loadApplySnapshot` reuses `verifyIssue` /
  `verifyIssueIteration` / `verifyBulkIssue*` / `verifyLabel` /
  `verifyMilestone` / `verifyBoard` for the equivalence verdict; on match,
  `applyPlan` skips the mutation, sets `state: "verified"` with
  `noOp: true`, records an audit `verified` event with a lifecycle reason,
  and writes a verification block describing the equivalent state.  JSON
  output includes `plan.preview` and `plan.noOp`; markdown appends a
  "NO-OP: equivalent remote state detected" notice.)*

#### F2 — Token scope introspection and remediation

- [x] Extend `auth status`, `doctor --check-api`, and `capabilities --json`
  with per-capability `usable: yes/no`, probe status, permission reason, and
  backend/source information.
  *(Implemented: `probeCapabilities` in `src/auth-resolver.ts` (exported via
  `src/types.ts`) runs read-only probes against the resolved REST transport;
  writes are labelled `usable:true backend:"gitlab-mcp"` when an MCP runtime
  source is present, otherwise `not-probed`.  `auth status --probe --json`,
  `doctor --check-api`, and `capabilities --probe` consume the same probe
  array.)*
- [x] Probe only safe read/current-user/metadata endpoints and clearly label
  capabilities that cannot be proven without a write; never turn doctor into a
  mutation test.
  *(Implemented: read definitions (`user.read`, `project.read`,
  `work-items.read`, `merge-requests.read`, `pipelines.read`, `labels.read`,
  `milestones.read`, `boards.read`) call only GET endpoints with a bounded
  page size of 1; writes are listed with `probe: "not-probed"` and a reason
  pointing at the `plan -> approve -> apply -> verify` flow.  `doctor`
  retains its existing non-mutating contract.)*
- [x] Make missing-scope errors name the supported oflow-level workaround when
  one exists, such as delegated MR creation or
  `git push -o merge_request.create`, instead of only returning a raw 403.
  *(Implemented: `normalizeForbidden(error: unknown)` checks numeric `.status`
  on `GitLabApiError` first, then falls back to a message regex; 403 emits
  `remediation` naming the broader-scope token, `glab auth login`, and the
  `oflow mr create --delegate` / `git push -o merge_request.create`
  workarounds; 401 emits a re-auth remediation.)*

#### F3 — Plan-backed merge-request writes

- [ ] Implement the `merge-requests.write` capability under the same
  `plan -> approve -> apply -> verify` lifecycle.
- [ ] Add `oflow mr create --description-file <path>` and
  `oflow mr update --iid <iid> --description-file <path>` so multiline
  descriptions remain intact and auditable.
- [ ] Support the selected REST/glab/delegated transport honestly, report the
  required scope before apply, and retain independent post-apply verification.
- [ ] Keep MR review, discussion, approval, and pipeline mutation operations
  separate; they are not silently included in this write milestone.

#### F4 — Verification flexibility and pipeline policy

- [ ] Treat `Done when` and equivalent description bullet sections as
  acceptance criteria when no checklist heading exists, while preserving
  conservative evidence semantics.
- [ ] Add an explicit `oflow plan issue update --convert-ac` operation for
  turning eligible bullets into stable task/checklist criteria; never rewrite
  descriptions implicitly.
- [ ] Detect projects without `.gitlab-ci.yml` and report missing pipeline
  evidence as `unknown`/warning rather than a permanent completion block.
- [ ] Add `pipeline=disabled` (or equivalent) project configuration with clear
  policy output and tests for enabled, absent, and disabled pipeline modes.

#### F5 — CLI discoverability and machine contracts

- [ ] Make `oflow help` and `oflow plan --help` document the actual top-level
  `approve <plan>` and `apply <plan>` commands, including `--state closed`.
- [ ] Make every plan-producing `--json` response expose a stable top-level
  `planPath` (while preserving the full plan object for compatibility).
- [ ] Publish JSON schemas/examples or a concise cookbook for `work`, `sync`,
  `audit.jsonl`, plans, receipts, and verification output.
- [ ] Add `oflow work --state closed|all`; make the effective state filter
  visible in JSON and text output.

#### F6 — Batch, normalized work-item, and low-risk ergonomics

- [ ] Add one bulk-note plan/apply flow for
  `plan issue note --stories <iid,...>` with bounded targets, shared-body
  verification, and partial-progress recovery.
- [ ] Expose one normalized read path per IID for issue-backed and Work Item
  resources; do not force agents to probe `/issues/` and Work Item endpoints
  separately.
- [ ] Add a safe milestone/iteration fallback: when the equivalent milestone
  already expresses the requested timebox, report a no-op/note rather than
  failing after an unsupported group-iteration lookup.
- [ ] Add `--yes` only for `issue.note.create`, preserving the audit event,
  target summary, verification, and explicit two-step approval for all other
  remote mutations.

The release checklist must trace every F1–F6 item to implementation,
regression tests, documentation, and a compatible JSON example before the
version is bumped. Native Codex/OMP packaging cannot displace this work.

### Session friction log — 2026-09-22 (post-F2 triage)

Ten concrete friction points from live agent use. Each maps onto the
F1–F6 structure or is recorded as new backlog with a fix sketch. None
block F3; several fold into F6.

| # | Friction | Maps to | Fix sketch |
|---|----------|---------|------------|
| 1 | `--add-labels` does not validate label existence before approval; missing labels silently no-op at apply | F6 | Dry-run lists labels being added with `[MISSING]` markers; approval blocked while any are missing unless `--force`; hint surfaces `oflow plan label create` |
| 2 | `plan issue create` has no `--type`/`--issue-type` flag; work items default to `issue` | F6 | Forward `issue_type` through `GitLabIssueCreate`; add `--type task\|issue\|incident\|requirement` to the create command |
| 3 | Stale-digest guard on bulk plans has no escape hatch; interrupted applies orphan approved plans | F1/F6 | `oflow plan <id> --supersede` atomically rebuilds against current IID state; partial-progress recovery reuses the existing bulk per-IID result tracking; auto-archive failed applies |
| 4 | `--assignee <username>` requires User:Read scope and fails with raw GitLab JSON | F6 | On granular-scope 403, accept numeric `--assignee-id` without the user lookup; print the oflow-level remediation inline (reuse `normalizeForbidden`) |
| 5 | `work --author` is case-sensitive and username-only; no human-name resolution | F5 | Accept username, display name, or email; resolve via a local member cache populated at `install`/first `work` invocation |
| 6 | Bulk plans silently capped at 50 IIDs; cap undocumented in `--help` | F6 | Auto-split into chunked plans of ≤50 (oflow already knows batching) and/or document the cap in help text |
| 7 | Apply interrupted mid-batch leaves ambiguous state; no resumable `applied-partial` | F1 | Add `applied-partial` state with `oflow apply --resume`; per-IID results already tracked for bulk ops — expose them for recovery |
| 8 | `work --json` omits `issue_type`/`work_item_type` | F5 | Include `issue_type` in the `work --json` payload; it is already on the wire from GitLab |
| 9 | No `labels audit` coverage command; agents hand-roll coverage counts | new backlog | `oflow labels audit [--label <name>]` returning coverage across open/closed grouped by type/milestone |
| 10 | No surface to change work-item type after create | F6 | `plan issue update --type` forwarding `issue_type` on the update payload (REST supports it) |

Priority signal from the session: the **type axis** (#2, #8, #10) and
**user-resolution axis** (#4, #5) were the costliest gaps — both forced
REST fallbacks. The **interruption model** (#3, #7) is the lifecycle
gap F1's partial-progress work must close.

### Stretch, only after the must-ship gates pass

- [ ] Package a thin Codex plugin/skill layer that calls `oflow` JSON.
- [ ] Package a thin native OMP extension/skills layer over the existing bridge
  and runtime-owned MCP configuration.
- [ ] Improve credential profile guidance without adding token minting to normal
  setup.

If the native plugin surfaces cannot be installed and smoke-tested in the same
release workflow, ship the corrected bridge and compatibility fixtures in
v0.3.0 and move the distributable plugin artifacts to v0.3.1.

### Explicitly deferred

Epic CRUD, iteration/cadence writes, merge-request reviews/discussions/
approvals, pipeline mutations, destructive deletion, repository push, and
credential minting remain later milestones. The explicitly scoped MR create/
update work above is not a general delivery API; it must remain plan-backed,
permission-aware, and independently verified.

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
- [x] Bounded `doctor --check-api` read capability matrix with explicit
  non-mutating write diagnostics

The current CLI is read-mostly against GitLab. `sync`, `work`, `context`, and
`verify` are read-only; issue, note, label, and milestone plan paths can only
mutate after approval.

### Phase 1 — Scrum and planning read model

This phase is the completed read-model foundation. The immediate
implementation focus is the post-0.2.1 reconciliation above.

- [x] Add `oflow capabilities --json` with supported, planned, and unavailable
  operations plus required token boundaries/permissions.
- [x] Detect optional `glab` without making it a hard dependency or exposing
  credentials.
- [x] Add `oflow sync` as a deterministic, read-only planning snapshot.
- [x] Add a token-light `oflow sync --summary` handoff for agent orientation.
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
- [x] Inspect iteration cadences where the GitLab version supports them through
  an explicit, compact parent-group GraphQL read.
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
- [x] Permit `glab` execution for the implemented issue-update action behind
  the same plan and approval gates; broader glab mutation coverage remains
  staged.
- [x] Implement post-apply verification for issue updates.
- [x] Add a durable local JSONL audit trail beyond the plan artifact.
- [x] Update issue/work-item fields through the guarded plan path.
- [ ] Audit field parity across REST, glab, and delegated transports for label
  replacement/add/remove, `epic_id`, due dates, weight, and milestone mapping.
- [x] Create work items through guarded plans; creation is non-retryable.
- [x] Close/reopen and assign work items through guarded issue updates.
- [x] Assign/remove work items from an existing epic through guarded issue
  updates; keep group-level epic CRUD separate.
- [x] Add issue/work-item progress notes through the guarded plan path.
- [x] Create/update labels through guarded plans; keep deletion disabled.
- [x] Apply/remove labels from guarded issue planning updates.
- [x] Apply/remove labels from bulk planning workflows.
- [x] Apply shared owner and milestone/timebox changes through bounded bulk
  planning workflows.
- [x] Assign or clear one issue's project-visible iteration through a guarded
  GraphQL `IssueSetIteration` mutation.
- [x] Assign or clear up to 50 issues' project-visible iteration through a
  sequential, stale-guarded GraphQL plan with partial-progress recovery.
- [x] Guard issue writes against stale remote `updated_at` preconditions.
- [x] Create/update project milestones through guarded plans; keep deletion disabled.
- [x] Create/update boards and label-backed board lists through guarded plans;
  keep deletion disabled and use issue labels for board-card movement.
- [ ] Create/update epics and broader relationships at group scope.
- [ ] Create/update iterations/cadences only after validating the target
  GitLab version and permission model.
- [x] Recover uniquely-identifiable note, label, milestone, board, and
  board-list creates when the remote resource appeared after plan approval;
  mismatched or duplicate matches are refused instead of duplicated.
- [ ] Add a durable caller-supplied identity for issue creation before making
  that non-idempotent operation recoverable.
- [ ] Keep deletion disabled by default; add it only as an explicitly gated
  capability.

### Phase 3 — Agent progress intelligence

- [x] Compare acceptance criteria to explicit local code/test references as
  bounded advisory evidence; never infer satisfaction from a file match alone.
- [x] Collect compact local Git, MR, pipeline, and note evidence for agent reasoning.
- [x] Classify explicit evidence as satisfied, partial, blocked, or unknown.
- [x] Detect stale stories with an explicit `sync --stale-days` threshold
  (agents can also select an older slice with `--updated-before`).
- [x] Detect conflicting board-state labels.
- [x] Detect missing acceptance criteria and work items without owners or
  timeboxes when the API provides the relevant fields.
- [x] Recommend the smallest next implementation or planning action.
- [x] Generate an approval-ready owner/timebox plan from those recommendations;
  other recommendations remain explicit agent/user decisions.
- [x] Add local context caching with explicit cached/refresh modes and no credentials.
- [x] Add a schema-migrated SQLite read model for compact work-item snapshots,
  indexed assignees/labels/state, and offline assigned-work reads.
- [x] Support concise Markdown and machine-readable reports suitable for Claude,
  Codex, CI jobs, and future agents.

### Phase 4 — Agent execution layer (current focus)

The vNext direction is documented in
[`VNEXT-ARCHITECTURE.md`](VNEXT-ARCHITECTURE.md): oflow owns workflow
semantics, evidence, policy, approval, and verification; GitLab MCP, `glab`,
REST, and GraphQL are interchangeable execution mechanisms resolved at
runtime. Phase 4 replaces "wrap more delivery endpoints" with an
agent-execution milestone.

### Phase 4a — Local planning dashboard foundation (done)

- [x] Extend the SQLite read model to merge-request, pipeline, iteration, and
  sync-history snapshots.
- [x] Add explicit cache status, age, invalidation, and migration diagnostics.
- [x] Add a loopback-only read-only dashboard backed by the local SQLite model.
- [x] Add explicit refresh controls without exposing GitLab credentials to the
  dashboard process or browser.

The foundation is exposed through `oflow dashboard`, `oflow sync --refresh`,
`oflow capabilities --json`, and the stable CLI JSON contract. The dashboard
only reads the local database; its refresh button records a local request and
shows the explicit CLI command required to contact GitLab.

### Phase 4b — Backend-neutral action schema

- [x] Versioned canonical action schema
- [x] Transport-independent plan artifacts (no backend, token, or transport
  command inside the plan)
- [x] Capability requirements on plans
- [x] Remote preconditions (stale `updated_at` guard)
- [x] Execution receipts
- [x] Generic postcondition verification interface
- [x] Migrate one existing action (`issue.update` via `executeIssueUpdate`)
  to the generic executor while keeping old plan artifacts readable

### Phase 4c — Smart authentication

- [x] GitLab host resolver (`--host`, config, git remote, `GITLAB_HOST`,
  authenticated glab hosts)
- [x] Environment auth detection (`GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`,
  `GITLAB_PRIVATE_TOKEN`)
- [x] glab auth detection and reuse as an authenticated transport without a
  duplicate oflow login
- [x] oflow credential store with per-host isolation
- [x] CI job-token detection with capability-limited use
- [x] Runtime-owned MCP auth state (configured vs authenticated, never
  scraping agent OAuth caches)
- [x] `oflow auth status` (text and `--json`, metadata only, no credentials)
- [x] Backend/auth selection diagnostics
- [ ] Separate configured, authenticated, readable, mutable, and verifiable
  states for each backend; make core reads honor the selected read transport
  or report explicit reduced mode
- [ ] Add `oflow identity --json` (or `auth whoami`) with GitLab principal and
  credential/backend metadata; make `work --mine` ID/server based
- [ ] Make capabilities and doctor report live backend/permission availability
  without probing writes

### Phase 4d — glab execution adapter

- [x] Authenticated reads without duplicate oflow login
- [x] Action execution behind the existing plan/approval gates
- [x] Strict structured output with argument-array invocation and error
  redaction
- [x] Verification remains owned by oflow

### Phase 4e — OMP host adapter and native extension

- [x] Detect OMP (binary, `.omp/` directory, `OMP_PROFILE`)
- [x] Managed `.omp/AGENTS.md` bridge with user-content preservation
- [x] OMP slash-command bridges (`/oflow-start`, `/oflow-status`,
  `/oflow-verify`, `/oflow-handoff`)
- [x] Detect `.omp/mcp.json`
- [x] Detect the GitLab MCP URL for the resolved host
- [x] Optional safe project-local GitLab MCP setup without secrets
  (`oflow install --with-gitlab-mcp`, `--no-mcp`)
- [x] OMP profile diagnostics without touching global OMP config
- [x] Tests for the OMP install matrix
- [ ] Package a native OMP extension/skills layer that delegates to oflow JSON
  and runtime-owned GitLab MCP without duplicating the GitLab adapter

### Phase 4f — Delegated GitLab MCP actions

- [x] Detect runtime-configured GitLab MCP
- [x] Emit delegated action descriptors (`oflow apply <plan> --delegate`)
- [x] Ingest execution receipts from agent-executed MCP calls
  (`oflow apply <plan> --receipt <file>`)
- [x] Independent verification through a read transport
- [ ] Clear reduced-mode reporting when no independent read transport exists

### Phase 4g — Agent lifecycle commands

- [x] `oflow start` — one compact, actionable working context
- [x] `oflow check` — unified assessment of local Git, story, evidence, MR,
  pipeline, and policy state with the next required action
- [x] `oflow finish` — gated story completion (read-only gates; closing stays
  a guarded `plan issue update --state closed` operation)
- [x] `oflow handoff` — compact context for the next agent
- [x] Compact JSON contracts for the above
- [ ] Claude validation
- [ ] Codex validation
- [ ] OMP validation
- [ ] Copilot/VS Code validation
- [ ] OpenWolf e2e validation for status, handoff, memory/anatomy boundaries,
  and credential non-retention

### Phase 4h — Delivery capabilities (bounded next-release slice)

Merge-request review/discussion state and delivery automation remain postponed,
but v0.3.0 includes the bounded, plan-backed MR create/update slice below.
Merge-request and pipeline reads are already included in the compact
sync/context evidence. Delivery actions enter as backend-neutral actions under
the same plan -> approve -> apply -> verify gates:

- [x] Merge-request creation through delegated GitLab MCP actions
  (`plan merge-request create` -> `approve` -> `apply --delegate` ->
  `apply --receipt` -> `verify`); review/discussion state remains deferred
- [ ] Implement `merge-requests.write` with plan-backed REST/glab/delegated
  create and update operations, multiline description files, permission
  diagnostics, and independent verification
- [ ] Branch and repository operations (optional; local Git preferred)
- [ ] Pipeline inspection and controlled trigger/cancel/retry operations
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

Capability discovery must also distinguish implementation support from current
runtime availability. In particular, MCP configuration is not proof of MCP
authentication, and an authenticated write backend is not proof of an
independent verification backend.

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
