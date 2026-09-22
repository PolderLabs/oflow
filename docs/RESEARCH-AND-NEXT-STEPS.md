# Post-0.2.1 research and next steps

**Status:** decision record
**Reviewed:** 2026-09-21
**Scope:** GitLab Scrum coverage, agent integrations, identity, token
onboarding, and alignment with the OpenWolf context project.

This document preserves the conclusions from the post-release review so the
next implementation pass does not lose the product boundary or repeat the
research. It complements, rather than replaces, [`ROADMAP.md`](ROADMAP.md),
[`GITLAB-INTEGRATION.md`](GITLAB-INTEGRATION.md), and
[`AGENT-INTEGRATION.md`](AGENT-INTEGRATION.md).

## Executive decision

`oflow` remains the workflow authority and GitLab-first JSON contract. It owns
normalized planning data, capabilities, policy, `plan -> approve -> apply ->
verify`, evidence, and verification. It should not grow a separate copy of
every agent host's GitLab integration.

The preferred integration boundary is:

```text
Codex / Claude / OMP / VS Code agent
                 |
                 +--> oflow CLI JSON (workflow, identity, plans, verification)
                 |          |
                 |          +--> REST or glab for deterministic reads/writes
                 |          +--> delegated GitLab MCP actions when available
                 |
                 +--> OpenWolf (context, anatomy, memory, handoff only)
```

GitLab MCP is an optional agent-facing transport, not the Scrum source of
truth. OpenWolf is an agent-context layer, not a GitLab client, credential
store, or replacement for oflow verification.

## Baseline after v0.2.1

The release is a solid foundation, but it is not yet the complete Scrum
control plane we ultimately want.

| Area | Current truth |
| --- | --- |
| Planning reads | Bounded work-item, label, milestone, board/list, iteration, group-epic, MR, pipeline, notes, cache, and sync evidence are implemented. |
| Guarded planning writes | Issue/work-item, note, label, milestone, board/list, owner/timebox, and bounded iteration changes use explicit plans and verification. Deletion remains disabled. |
| Progress intelligence | Acceptance criteria, local Git/test references, stale work, ownership/timebox gaps, board conflicts, cache state, and next-action recommendations are advisory and evidence-based. |
| Agent lifecycle | `start`, `check`, `finish`, and `handoff` provide compact machine-readable context. Host validation is not complete. |
| Delivery | Merge-request creation works through delegated GitLab MCP receipts. The v0.3.0 slice adds plan-backed create/update with multiline description files; discussions, review state, and pipeline trigger/cancel/retry remain deferred. |
| OMP | The project-local bridge, commands, MCP detection, and safe project-local MCP setup exist. This is a bridge, not yet a distributable native OMP extension. |
| Codex/Claude/OpenWolf | The shared CLI contract is portable. Native Codex packaging and OpenWolf end-to-end fixtures still need an explicit compatibility pass. |

The implementation must continue to distinguish a supported operation from a
complete provider API. The following remain intentionally out of the default
surface until their permissions, idempotency, and verification are designed:

- group epic CRUD and broad hierarchy writes;
- iteration/cadence creation and updates;
- dedicated task/checklist hierarchy mutations and newer Work Item widgets
  beyond the explicit acceptance-criteria conversion path;
- merge-request reviews, discussions, approvals, and broader delivery
  mutations; the bounded v0.3.0 create/update slice is specified above;
- pipeline trigger, cancel, retry, and other delivery mutations;
- destructive deletion and repository/source-push operations.

Acceptance-criteria checkboxes are a local convention and useful evidence
anchors; they are not proof by themselves that a criterion is semantically
satisfied.

The implementation and documentation also need a field-parity audit before
more mutation work: labels replacement versus add/remove, `epic_id`, due
dates, weight, and milestone title/id mappings must be explicit for every
transport. A capability must not be advertised merely because one backend can
accept a related field.

## Release and operating baseline

The v0.2.1 release is the baseline for this work. The repository's GitHub
Actions workflow is the canonical release/check path, so a local npm publish
CLI is not a prerequisite. Keep package/version/tag checks, public-content
scanning, tests, typechecking, and pack validation in the workflow before
future releases.

## Findings that must shape the next implementation

### P0: authentication truth is not yet transport truth

The auth resolver can detect environment credentials, stored oflow
credentials, `glab`, and runtime-owned MCP configuration. Some core commands
still instantiate the direct REST client instead of using the resolved read
transport. Therefore an auth result can currently overstate what `sync`,
`context`, `doctor`, or current-user lookup can actually do.

The next auth contract must expose separate states:

```text
configured -> authenticated -> readable -> mutable -> verifiable
```

`configured` MCP is not authenticated MCP. A successful credential discovery
is not a successful GitLab read. A read backend is not automatically a write
backend, and a delegated write is not verified until an independent read
transport confirms it. Reduced mode must be explicit when independent reads
are unavailable.

The direct oflow environment names are `GITLAB_TOKEN`,
`GITLAB_ACCESS_TOKEN`, and `GITLAB_PRIVATE_TOKEN`. Do not document
`OAUTH_TOKEN` as an oflow direct-token variable; it may still be relevant to a
separate client such as `glab`.

### P0: make GitLab identity first-class

Add `oflow identity --json` (or an equivalent `auth whoami` command) backed by
GitLab's `/user` endpoint. It should report, without token material:

- resolved host and credential source/backend;
- authenticated GitLab user id, username, and display name;
- email/public-email fields only when GitLab permits them;
- whether identity, assigned-work reads, planning writes, and verification
  are available.

`work --mine` should use the authenticated user id or a server-side
`assignee=me` query. It must never infer a GitLab assignee from the local Git
author, model name, agent name, or an email typed into an instruction file.
Missing `User: Read` access should produce a clear capability result rather
than silently returning the wrong work.

### P0: make capabilities live and honest

`oflow capabilities` is currently an implementation catalog. It must evolve
into a clear distinction between:

- implemented by oflow;
- available through the selected backend and current identity;
- configured but runtime-owned (MCP);
- unavailable because of endpoint/version/permission/backend;
- planned or intentionally disabled.

`doctor` should report that matrix without probing writes. A write must still
be tested only through a real plan and the normal approval lifecycle.

### P0: reconcile the generated host contracts

Before adding more adapters, fix the existing contract drift:

- ensure `/oflow-start`, status/check, verify, and handoff templates promise
  exactly the JSON and policy that the CLI returns;
- make the OMP handoff bridge invoke structured `oflow handoff`, not a generic
  sync substitute;
- validate Claude, Codex, OMP, Copilot/VS Code, and OpenWolf flows with the
  same fixture and evidence expectations.

## Session-friction feedback: mandatory v0.3.0 closure

The next release must also address the concrete failures and workarounds found
while using oflow against real planning data. These are release requirements,
not a new unsorted backlog; the full checklist and IDs live in
[`ROADMAP.md`](ROADMAP.md#mandatory-session-friction-closure).

| ID | Required outcome | Guardrail |
| --- | --- | --- |
| F1 | Expiring/session-bound plans, list/discard, target-title pre-apply diff, and equivalent-state no-op detection | Stale or cross-session plans refuse by default; only an explicit force path can continue after a fresh target check. |
| F2 | Per-capability token/scope usability in auth, doctor, and capabilities, with actionable workaround errors | Probes remain read-only; configured MCP is not treated as authenticated; raw 403s are normalized into oflow guidance. |
| F3 | `merge-requests.write`, plus plan-backed `mr create/update --description-file` | Multiline descriptions stay intact; every write is approved, auditable, and independently verified. |
| F4 | `Done when`/bullet acceptance parsing, explicit AC conversion, and no-CI policy | No implicit description rewrite; absent CI is warning/unknown unless policy explicitly requires it. |
| F5 | Correct help paths, stable `planPath` JSON, output schemas/cookbook, and `work --state closed|all` | Human and machine contracts are documented and tested together. |
| F6 | Bulk notes, normalized IID reads, milestone/iteration equivalent fallback, and audited note `--yes` | Bounded targets, partial-progress recovery, no silent mutation, and two-step approval retained for all higher-risk writes. |

The order is deliberate. F1 prevents another unrelated stale-plan mutation;
F2 removes permission trial-and-error; F3 removes the SSH push-option
workaround; F5 ensures agents can discover and capture every result; F4 and F6
then make verification and repeated Scrum operations reliable. Native Codex or
OMP packaging cannot be called complete while these core contracts are still
missing.

The v0.3.0 implementation must carry a traceability record for every F1–F6
item: source file(s), regression test, documentation/example, and release-gate
evidence. A feature is not complete merely because its REST endpoint works.

## Identity and token onboarding decision

### Normal profiles

Document and eventually offer explicit profiles rather than one opaque token
request:

1. **Planning read:** project/user/work-item/label/MR/pipeline reads, with
   group read only for group epics, iterations, or cadence data.
2. **Planning write:** the read profile plus the smallest Work Item, Label,
   Project Planning, and GraphQL iteration-assignment permissions required by
   the selected actions.
3. **Delegated runtime:** GitLab MCP OAuth owned by the agent runtime, with
   oflow producing delegated action descriptors and independently verifying
   when a second read transport exists.

Keep repository push, CI/CD variables, runners, deployments, secrets,
security administration, webhooks, memberships, token management, and delete
permissions out of these normal profiles.

### Credential-minting bootstrap is opt-in, not the setup path

The requested idea of entering one token that can create replacement tokens
is a high-privilege credential factory. It should not be required for normal
Scrum setup and should not be hidden behind a friendly “make compatible”
wizard.

If a future advanced flow supports it, the safety contract is:

1. opt-in and clearly labelled as credential-minting authority;
2. accept the bootstrap secret only through protected stdin or a runtime
   secret channel, never a command argument, repository file, prompt output,
   SQLite database, or OpenWolf memory;
3. derive and display the exact host, resource boundary, permissions, expiry,
   and intended use before creation;
4. create the replacement only through an explicit approval step;
5. test the replacement with `identity`, representative reads, and the
   requested guarded action;
6. show explicit revoke/remove instructions for the bootstrap credential and
   never retain it automatically.

Where possible, prefer GitLab MCP OAuth, a project/group/service account token,
or a manually created fine-grained PAT over token minting. GitLab's ordinary
user token REST API does not provide a general user-facing “create any token”
primitive; administrative creation and experimental GraphQL token creation
have materially different authority and lifecycle risks.

## Agent and plugin direction

Do not duplicate the GitLab API in every host integration.

- **Core:** oflow CLI and stable JSON remain the portable contract.
- **GitLab transport:** direct REST is deterministic; `glab` is optional;
  hosted GitLab MCP is optional and delegated; verification remains oflow's
  responsibility.
- **Codex:** package a thin plugin/skill surface that teaches the CLI flow and
  optionally exposes the GitLab MCP connection. It must not store tokens or
  reimplement planning rules.
- **OMP:** evolve the current project bridge into a native extension with
  commands/skills and native MCP configuration only after P0 contract fixes.
  The extension should call oflow and return its JSON, not fork the adapter.
- **OpenWolf:** keep anatomy, memory, session status, and handoff context
  separate from GitLab authorization and remote truth. OpenWolf should help an
  agent find the oflow contract and preserve decisions, but never cache a
  token or claim that a plan was verified.

The native packaging work is a thin distribution layer over one contract, not
a new provider abstraction. The existing OMP bridge remains a useful fallback
while that package is developed.

## Compatibility matrix to build before calling this complete

Every row should exercise read orientation, identity, cache use, plan creation,
approval, apply, independent verification, reduced-mode reporting, and token
redaction where applicable.

| Host/runtime | Required evidence |
| --- | --- |
| Direct oflow token | `/user`, project reads, planning write, verify, exact env/store source. |
| `glab`-authenticated | resolved read/write backend, no duplicate login, verification and error redaction. |
| GitLab hosted MCP | configured vs authenticated distinction, delegated receipt, independent-read warning. |
| OMP bridge/native extension | command output matches CLI JSON; MCP remains runtime-owned. |
| Codex plugin/skills | instructions discover identity, capabilities, and plan gates without raw credentials. |
| Claude/Copilot/VS Code | shared workflow contract and host-specific instructions remain idempotent. |
| OpenWolf e2e fixture | status/handoff/memory/anatomy behavior stays separate from oflow remote state. |

## Reconciled execution order

1. **P0 safety and truth:** F1 plan lifecycle hygiene, F2 capability/scope
   introspection, transport truth, identity, live capability reporting, and
   OMP command/template drift.
2. **P0 delivery and verification:** F3 plan-backed MR create/update, F4
   acceptance/pipeline policy, and independent verification.
3. **P0 agent operability:** F5 discoverability/JSON contracts and F6 bounded
   batch, normalization, fallback, and low-risk note ergonomics.
4. **P1 packaging and onboarding:** shared Codex plugin, native OMP extension,
   compatibility fixtures, and explicit read/write credential profiles.
5. **P2/P3 breadth:** epic hierarchy writes, iteration/cadence writes, MR
   discussions/reviews, and controlled pipeline operations, each with its own
   backend-neutral action and independent verification contract.

Do not begin token minting, destructive operations, or a full GitLab API
wrapper before the P0 contract and identity tests are green.

## External references

- [GitLab current-user API](https://docs.gitlab.com/api/users/#retrieve-the-current-user)
- [GitLab work items](https://docs.gitlab.com/user/work_items/)
- [GitLab iterations](https://docs.gitlab.com/user/group/iterations/)
- [GitLab fine-grained personal access tokens](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/)
- [Fine-grained REST permission mapping](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/)
- [Personal access token API](https://docs.gitlab.com/api/personal_access_tokens/)
- [User token API](https://docs.gitlab.com/api/user_tokens/)
- [GitLab GraphQL token creation reference](https://docs.gitlab.com/api/graphql/reference/#mutationpersonalaccesstokencreate)
- [GitLab project access tokens](https://docs.gitlab.com/api/project_access_tokens/)
- [GitLab hosted MCP server](https://docs.gitlab.com/user/model_context_protocol/mcp_server/)
- [OpenAI plugin architecture](https://developers.openai.com/plugins/concepts/plugins?site_locale=en)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins?site_locale=en)
- [OMP MCP configuration](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md)
- [OMP extension packages](https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md)
