# Agent workflow

This repository contains `oflow`, a GitLab-first workflow CLI for Claude and
Codex agents.

## Working agreement

- Read `README.md` and the relevant source before changing behavior.
- Keep the CLI dependency-light and usable from a fresh npm install.
- Preserve the separation between local workflow files and provider API clients.
- Do not add credentials, local state, or generated `dist/` output to commits.
- This is a public repository: never add private client/company details,
  employee identities, private hosts/paths, screenshots, logs, or credentials;
  use synthetic placeholders and run `npm run check:public`.
- Keep `oflow install` idempotent and preserve user-authored content.
- Add or update tests for parser, detection, scaffold, and verification changes.
- Run `npm run check:public`, `npm test`, `npm run typecheck`, and
  `npm pack --dry-run` before handoff.

## Product boundary

GitLab is the only provider in this release. The local contract is the stable
surface: `.oflow/WORKFLOW.md`, `AGENTS.md`, `CLAUDE.md`, story context, and
acceptance verification. Provider-specific API behavior belongs in an adapter.

Mutating GitLab actions must eventually follow `plan -> approve -> apply ->
verify`; do not introduce implicit remote writes into read-only commands.
