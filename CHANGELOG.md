# Changelog

## Unreleased
### Added
- Overview stage counts now focus the work map while retaining parent context.
  Guided agent handoffs explain story-specific start, assessment and resume
  brief commands, with explicit copy-only and terminal-read boundaries.
- Overview now includes an interactive Scrum work map with board/iteration
  filters, parent-to-child connections, selected-item context, and zoom.
  Missing parents and ambiguous stage labels stay explicit; the map never
  infers dependencies from shared labels or matching issue numbers.
- Redesigned local dashboard with a responsive workspace, searchable story
  handoffs, dedicated delivery and planning views, and explicit snapshot
  coverage, freshness and next-action guidance. No frontend dependencies or
  implicit GitLab writes.
- Dashboard read API now includes snapshot query, work-item truncation and
  planning-health metadata. README and dashboard documentation describe the
  daily workflow and the maintained design contract.
- `oflow labels audit` reports labels defined on a project against the ones
  actually used by issues, so an unused label is visible without opening the
  project settings. Read-only: it opens no plan and applies nothing. The report
  carries a coverage warning when the issue listing could not be exhaustive, so
  a partial result is never read as a complete one.
- `oflow doctor --check-api` now reports in a structured layout: a coloured
  banner with a `[GitLab API: PASS/FAIL/SKIP/N/A]` badge, grouped read and
  write capabilities with latency, a "Custom work item types" section that
  names the items REST cannot see (User Story, EPIC, etc.) and tells you the
  count, and a Recommendations block with concrete remediation paths for
  failed probes and the missing `Work Item Type: Read` scope on hosted GitLab
  and self-managed >=16.9.
- `oflow assess` and `oflow verify` now name the job that failed a story's
  verification pipeline. A pipeline status says something broke; the failed-job
  read says what, so an agent can act without leaving oflow for the GitLab UI.
  One bounded read of the selected pipeline, and only when it is not green. A
  job that failed with `allow_failure` did not fail the pipeline and is never
  named as the cause, and a rejected read is reported as a warning instead of
  becoming a clean result or a softer gate. `pipelines.jobs.read` is a new
  capability, `doctor --check-api` probes it against the most recent pipeline
  and skips it when the project has never run CI, and the `pipelines.read`
  permission row now names the fine-grained `Pipeline: Read` scope that
  `doctor` already knew a token could lack.
  The failed job also reaches the artifacts an agent actually copies: `check`,
  `handoff`, and the story context markdown render a `Failed jobs` section,
  and the dashboard handoff brief carries it in its delivery block. Each
  renders only when the read actually happened, so no surface can present a
  skipped read as a clean job list. The scope filter is percent-encoded, and a
  `insufficient_granular_scope` rejection names GitLab issue 627693 so a user
  is not sent hunting for a scope they already granted.
  The read was checked against GitLab's documented jobs response, which
  confirms the six fields oflow parses and showed that `order_by`/`sort` are
  not parameters of this endpoint — they belong to the pipeline list, and the
  job list already returns newest first. A fixture built from the documented
  response now pins the parse, including that the fields oflow does not read
  stay out of its output.

### Changed
- GitHub Actions are gone. `quality` (push and pull request, Ubuntu and
  Windows) and the manual `publish` workflow were removed, and Actions are
  disabled for the repository, because Actions usage had outgrown what the
  account's plan covers. Nothing was gated on them: `quality` had been failing
  on `main` at the Windows `Run tests` step while releases shipped, and
  `publish` published through npm Trusted Publishing without a local rerun. The
  same checks now run only where they are invoked, from a maintainer machine,
  before a push or a release. `.github/dependabot.yml` keeps the npm
  dependency updates and drops the `github-actions` ecosystem, which had no
  workflows left to update. Releases are published with
  `npm publish --access public`, which runs `prepublishOnly` (`check:public`,
  then `build`) and can no longer carry npm provenance attestations.
- `start`, `check`, `finish`, and `handoff` selected a story by loading the
  whole story context — project, issue, notes, related merge requests, branch
  and merge-request pipelines, and failed jobs — and then kept only the IID
  before loading the same context again. On the explicit `--story <iid>` path
  — the one the agent instructions tell agents to always use —
  `oflow check --story 42` issued ten GitLab requests for five distinct reads,
  and now issues five. Story selection no longer performs a lookup of its own
  when the IID is given, and `start` reports the normalized story from the
  context it already loaded rather than a second copy. A regression test
  counts the context reads.
- `oflow capabilities --probe` reported `pipelines.jobs.read` with the generic
  "no probe handler registered", which reads like an oversight while
  `doctor --check-api` reports the same capability as passed or skipped with a
  real reason. A deliberately unprobed capability now states why.

### Fixed
- The dashboard page did not load. A route-matching regular expression was
  written with a single backslash-escaped slash inside the page's inline
  script, and the backslash was consumed when the template was emitted, so the
  script failed to parse with `SyntaxError: Unexpected token ')'` and the
  browser rendered nothing. The companion URL check was double-escaped and
  survived, which is what located it.
- Secret redaction on the dashboard's HTTP boundary matched field names
  exactly, so only a bare `token` was dropped. `accessToken`, `apiKey`,
  `clientSecret`, `privateKeyPem`, `refreshToken`, `x-api-key` and similar
  shapes crossed to the browser intact. Names are now matched per word across
  camelCase and separators, with the transport health signals the auth panel
  renders kept explicitly.
- The dashboard's cross-origin check was never actually exercised. The test
  sent a forged `Host` header through `fetch`, which drops that header before
  it reaches the wire, so the request arrived legitimately and the test read
  the success as an accepted forgery. The protection was sound and is now
  proven on a raw socket, so a regression in it fails the suite.
- Same-origin browser actions now work when the dashboard uses `--port 0`;
  Origin validation uses the actual bound port rather than zero.
- `plan issue update --add-labels` accepted a label the project does not
  define. GitLab took the request and added nothing, so the command reported
  success and showed a label that does not exist. It is now rejected before the
  request, naming the label.
- `--assignee` leaked raw GitLab JSON into the output when the token lacked
  granular scope. It now reports that the lookup is not permitted.
- Toggling a criterion printed `issue updated (unknown)` because the apply
  path never set the state field. It now names the criterion that landed.
- `work --author` sent the username as typed rather than the canonical one
  GitLab expects, and an empty result under an author filter read as "this
  person has no work". It now normalises the name and distinguishes an empty
  filtered result from no work at all.
- The agent instruction blocks told agents to run `oflow
  normalizeForbidden`, which is not a command. The blocks are the one thing
  an agent reads before acting, so a missing command there is a dead end.
- `npm run build` did not clean `dist`, so a module deleted from `src` kept
  shipping in the published tarball.

## 0.5.2
Correct the 0.5.0 changelog entry and harden the criterion-toggle verifier.
### Fixed
- The 0.5.0 entry claimed `--check` and `--uncheck` were listed in `oflow
  --help`. That version shipped without them; the help lines shipped in 0.5.1.
  The duplicate claim is removed so the published changelog no longer credits
  0.5.0 with a fix it did not contain.
- `verifyCriterionToggle` read `note.body` unguarded, so a note returned without
  a body raised a raw `TypeError` out of the verifier instead of reporting a
  failed check. It now reads an absent body as "not found", matching every
  sibling verifier.

## 0.5.1
Document the task-completion flags in `oflow --help`.
### Fixed
- `--check` and `--uncheck` were absent from the help text, so the 0.5.0
  feature shipped undiscoverable: a user reading `--help` had no way to find
  how to tick a task. Both now appear in the command summary and the flag
  reference, and a test fails if either line is removed.

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
