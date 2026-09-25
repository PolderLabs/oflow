# Changelog

## Unreleased

### Added

- Dashboard v2: `oflow dashboard` now serves a six-view cockpit (Overview,
  Capabilities, Auth, Diagnostics, Lifecycle, Tour) with new read-only
  endpoints `/api/capabilities`, `/api/plans`, `/api/verification`, and
  `/api/audit`, an explicit `POST /api/check-api` diagnostics probe, and an
  Auth view that reports token state without ever accepting a token.
- `oflow dashboard --open` launches the default browser using the platform
  opener (`open`, `start`, `xdg-open`) and never fails the command when no
  opener is available.

### Security

- Dashboard responses are redacted: home directories collapse to `~`, other
  absolute paths fall back to a basename, and secret-looking fields are dropped
  from doctor reports. Table cells are escaped centrally in the view, so
  GitLab-controlled strings (issue titles, project paths, capability notes)
  cannot inject markup into a localhost page.
- Mutating dashboard routes validate `Origin` and reject any origin other than
  the server's own `127.0.0.1` address; `POST /api/auth/request` accepts an
  action only and refuses a browser-supplied host.

### Fixed

- Cached `work --mine` snapshots are now bound to the authenticated GitLab
  actor ID stored in the SQLite cache query row. Legacy snapshots without an
  actor ID are rejected with `WORK_CACHE_IDENTITY_MISMATCH` /
  `WORK_CACHE_IDENTITY_UNAVAILABLE`; non-mine cached reads remain offline and
  retain their existing key shape. SQLite schema bumped to v3 with an
  idempotent `actor_id` column.

## 0.3.0

Reliability and agent-integration release.

### Added

- First-class GitLab identity: `oflow identity --json` returns the authenticated
  principal with optional email surface; documented in
  `docs/JSON-COOKBOOK.md`.
- Transport lifecycle: configured, authenticated, readable, mutable, and
  verifiable states for REST, `glab`, and runtime-owned MCP. `oflow doctor`
  and `oflow capabilities --json` agree on backend, permission, and
  runtime-owned state without probing writes.
- Live ID-keyed `work --mine`: `--mine` resolves the GitLab principal and
  filters by `assignee_id=<n>` instead of `assignee_username`. Cached
  snapshots still key on the prior cache contract — see open v0.4 work.
- Reduced-mode reporting: `capabilities.reduced` is true when no proven read
  backend resolves; core context reads route through a transport resolver
  (`src/context.ts#resolveContextRead`) and emit `READ_TRANSPORT_UNAVAILABLE`
  rather than silently constructing REST clients.
- Compatibility fixtures for direct token, glab-only, runtime MCP delegated,
  Claude Code, Codex, OMP, Copilot/VS Code, and OpenWolf hosts.
- Capability catalog: `merge-requests.write` documents the delegated MR
  boundary; portable issue-update fields are explicitly not advertised for
  delegated MCP.

### Fixed

- `oflow plan --help` is now discoverable; `--help`/`-h`/`help` after
  `plan` routes to the top-level command help instead of the unsupported
  plan resource error.
- `oflow verify` reports a missing `.gitlab-ci.yml` as a warning under
  enabled policy instead of a permanent completion block.
- `safeProjectIterations` only falls back to the milestone path on a GitLab
  API `404`; authentication, permission, transport, and server failures
  propagate unchanged.
- F6 duplicate explicit AC ids in `convertBulletsToAcceptanceCriteria`
  are reallocated instead of colluding on the same ID.

### Known limitations

- Cached `work --mine` snapshots do not yet persist the resolved actor id;
  the cache contract will be extended in a separate v0.3.x slice.

## 0.2.1

Hardening follow-up to the delegated action flow.

### Fixed

- `oflow apply` refuses delegated-only plans before any remote call (guard
  hoisted and driven by `DELEGATED_ONLY_OPERATIONS`).
- A successful receipt ingestion now clears a stale `applyError` left by an
  earlier failed attempt.
- `oflow finish` requires the story merge request to be merged, not merely
  present.
- Windows CI: the fake-glab auth-resolver test is skipped like the other
  glab tests (Windows cannot exec shebang scripts).

### Added

- Verified delegated plans report the transport split: the agent executed via
  GitLab MCP while oflow verified through its own REST read.
- CLI-level test covering the full delegated loop: plan -> approve -> refused
  direct apply -> delegate -> refused early verify -> receipt -> verify.

Agent execution layer: delegated GitLab MCP actions, richer doctor
diagnostics, the complete agent lifecycle, and color output.

### Delegated GitLab MCP actions

- `oflow apply <plan> --delegate` emits a delegated action descriptor for the
  agent runtime's GitLab MCP tool (`merge_request.create`).
- `oflow apply <plan> --receipt <file>` ingests the executed action receipt:
  successful receipts transition the plan to `applied` for independent
  verification; failed receipts record `apply-failed` and stay retryable.
- `oflow plan merge-request create --story <iid>` prepares the guarded plan
  (`--source-branch`, `--target-branch`, `--title`, `--description`).
- Fixed `merge_request.create` plans being rejected on load and
  `delegated`/`receipt` audit events being dropped from `oflow audit` reads.

### Doctor diagnostics

- `oflow doctor --check-api` reports token scopes through the read-only
  personal-access-token self endpoint (skipped, not failed, when the host or
  token kind does not support it).
- Every API probe reports latency.

### Agent lifecycle

- `oflow finish` — read-only completion gates (criteria, merge request,
  pipeline, clean tree) plus the guarded close command to run next.
- `oflow handoff` — compact resume context for the next agent.

### Presentation

- Text output for `doctor` and `finish` uses ANSI color on a TTY; disabled by
  `NO_COLOR` or when not a TTY. `--json` output is unchanged.

## 0.1.0

Initial public release: GitLab-first workflow CLI with story context,
acceptance-criteria verification, guarded plan -> approve -> apply -> verify
mutations, compact Scrum reads, SQLite read model, and local dashboard.
