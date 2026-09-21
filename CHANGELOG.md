# Changelog

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
