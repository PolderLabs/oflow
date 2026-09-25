# Changelog

## 0.5.0
Mark a task complete in a guarded plan. GitLab has no writable task field:
`task_completion_status` appears in issue responses but is absent from the
documented parameter list for `PUT /projects/:id/issues/:issue_iid`, and there
is no `tasks` subresource. Ticking a task is a description edit, and that is
what this does.
### Added
- `plan issue update --check <id|position>` and `--uncheck` flip a single
  checklist item in the acceptance section and record an issue note naming
  the criterion, in one plan, so the tick and its audit trail are a single
  approval and cannot half-apply. A positional reference resolves inside the
  acceptance section only, so it can never tick a box under another heading.
- The audit note reports `n of m` over every checklist in the description,
  which is how GitLab derives `task_completion_status`; the acceptance-section
  parser sees only part of that list.
- `issue.criterion.toggle` is a distinct plan kind, visible in `plan`,
  `approve`, `apply`, `verify`, and the audit log.
### Notes
- The description write happens first. The note must never claim a tick that
  failed, so a failed description update leaves no note behind.
- `verify` asserts the description text and the note, but not the counter:
  GitLab recomputes it and can serve a value computed just before the write
  landed, so asserting it produces false failures on a correct apply.
- Ticking an already-correct criterion writes no plan and exits 1.
- `--check` and `--uncheck` are listed in `oflow --help`; an undiscoverable
  flag is an unusable one.

## 0.4.4

Finish honouring `--description-file` across the remaining plan commands.

### Fixed

- `plan label create`, `plan label update`, `plan milestone create`, and
  `plan milestone update` had the same dropped-flag defect fixed in 0.4.3 for
  the issue paths: the parser accepts `--description-file` for every command,
  but these four sites read `options.description` directly, so a body supplied
  as a file never reached the plan. The create commands dropped it silently
  and planned a label or milestone with no description; the update commands
  refused with `EMPTY_PLAN` naming `--description` rather than the flag
  actually passed. All four now resolve the flag, matching the issue and
  merge-request commands.

## 0.4.3

Fix the dropped `--description-file` flag on issue create and update.

### Fixed

- The argument parser accepts `--description-file` for every command, but the
  issue create and issue update sites read `options.description` directly
  instead of resolving the file, so the flag never reached the plan. The two
  commands failed differently: `plan issue create` dropped the body silently
  and planned an issue with no description, while `plan issue update` came
  out with an empty change set and refused with `EMPTY_PLAN`, naming
  `--description` rather than the flag actually passed. Both now resolve the
  flag the way the merge-request commands already did, so an agent can write
  an issue body from a file on either command.

## 0.4.2

Repository owner correction in published links.

### Fixed

- `package.json` `bugs.url` and the README links named `PolderLabsVOF/oflow`, a
  stale owner from before the organization was renamed to `PolderLabs`. GitHub
  still redirects the old name, so the links worked, but the npm page
  advertised an organization that no longer exists. The `gh release create`
  command in `docs/RELEASING.md` named it as well.

## 0.4.1

Windows plan-path fix.

### Fixed

- `oflow` plan commands no longer refuse a valid plan on Windows. The plan
  path guard compared a caller-supplied plan path against `.oflow/state/plans`
  lexically, but `git rev-parse` reports a forward-slash long path while a
  Windows temp path is a backslash 8.3 short name. `relative` read that
  mismatch as a `..` chain and `approve`, `apply`, `discard`, and the session
  lookup all failed with `UNSAFE_PLAN_PATH`. The lexical check remains the
  guard; only when it fails does the guard retry on canonical paths, and a
  real traversal still fails both. The canonical pass uses
  `realpathSync.native`, because the JavaScript `realpathSync` keeps an 8.3
  short name intact and so never made the two spellings comparable.

## 0.4.0

Dashboard v2 release.

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
- The dashboard's raw-cell opt-in is tagged with a `Symbol` rather than a
  `__html` string key, so a `__html` field in a GitLab-sourced API response
  can no longer be promoted to raw markup without passing through
  `rawCell()`.
- The doctor report sent to the browser is now an explicit allowlist
  projection rather than a denylist filter, so a field added to
  `DoctorReport` in future is withheld by default instead of being forwarded
  unreviewed. The remote is reduced to host and project path.

### Fixed

- Cached `work --mine` snapshots are now bound to the authenticated GitLab
  actor ID stored in the SQLite cache query row. Legacy snapshots without an
  actor ID are rejected with `WORK_CACHE_IDENTITY_MISMATCH` /
  `WORK_CACHE_IDENTITY_UNAVAILABLE`; non-mine cached reads remain offline and
  retain their existing key shape. SQLite schema bumped to v3 with an
  idempotent `actor_id` column.
- Dashboard error responses are keyed on the specific `OflowError` code, so a
  domain failure is reported as `500` rather than a client `400`, and an
  oversized request body returns `413`.
- The Overview view describes snapshot and read-model state honestly: a
  repository that has never synced reads "no snapshot yet" instead of
  "unknown", and an uncreated database reads "not created yet" instead of
  "sqlite ready".
- The generated agent contract now says the dashboard never *sends* GitLab
  credentials to the browser, rather than never receives them. The dashboard
  process does resolve a token locally for an explicit API check. Re-run
  `oflow install` to refresh the wording in an existing checkout; the managed
  block is replaced in place, so no user content is lost.
- `doctor --check-api` no longer reports a total API failure for a token that
  can read the project. The headline now reflects core read capability
  (`project.read`) rather than every optional probe, so a fine-grained token
  without `User: Read` — which only `work --mine` needs — no longer makes the
  whole product look broken while `sync` works. A `401` still fails the
  headline, because a rejected token does break every read path. Every failed
  probe is still reported individually with its own remediation.
- The dashboard no longer presents an unreadable source as an empty one. `sync`
  records a warning when an optional read (pipelines, merge requests, labels)
  is refused by a fine-grained token, but the dashboard dropped that warning,
  so an Overview reading "0 Pipelines" claimed the project had none when the
  token simply could not read them. The snapshot's warnings now reach the
  dashboard. A "Data sources this token cannot read" section names each one,
  and only the cards that own an unreadable source carry an amber
  "not readable with this token" caption, so a readable zero is never shown as
  an unreadable one. Advisory warnings (type coverage, a drifted remote, a
  snapshot from another branch) are listed separately under "Sync warnings"
  rather than presented as scope gaps. Each gap bullet leads with the source
  and HTTP status and keeps the raw API text behind a disclosure.

### Changed

- Dashboard presentation: metric cards now have real internal hierarchy
  (value, label, caption) instead of reading as one run-on string; tables get a
  sticky header, row hover, zebra separation, tabular figures, and an internal
  scroll region; the sidebar has a clear active state with an accent bar; the
  page gains depth and a responsive layout that stacks below 880px.
  Timestamps render compactly ("4m ago") instead of as a full ISO string with
  a timezone offset, falling back to the original text when unparseable.

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
