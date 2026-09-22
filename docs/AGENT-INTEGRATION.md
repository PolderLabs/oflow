# Agent integration boundary

`oflow` is a local CLI and read model with a portable JSON contract. It is not
yet an agent-host-specific plugin, and that boundary is intentional: Claude,
Codex, GitHub Copilot, VS Code agents, CI jobs, and other terminal-capable
agents can use the same contract without duplicating GitLab logic or sharing
credentials with a browser or editor extension. The post-0.2.1 decisions are
tracked in [`RESEARCH-AND-NEXT-STEPS.md`](RESEARCH-AND-NEXT-STEPS.md).

## The stable contract

Agents should use these layers in order:

1. Read `.oflow/WORKFLOW.md` and the repository's local instructions.
2. Run `oflow work --mine --refresh --json` and
   `oflow sync --summary --refresh --json` at a session or mutation boundary.
3. Use `oflow work --mine --cached --json` and
   `oflow sync --summary --cached --json` while repeatedly exploring.
4. Load focused evidence with `oflow context --story <iid> --json` or
   `oflow assess --story <iid> --json` only when needed.
5. Discover support with `oflow capabilities --json` rather than guessing.

At the beginning of a new session, `oflow doctor --check-api --json` is an
optional setup diagnostic. It checks bounded read access and shows every
supported write as `not-probed`; it never mutates GitLab. A passing doctor
result means the representative reads worked, not that the token's exact
fine-grained configuration can be reconstructed.

The CLI's JSON output is the integration surface. Agents do not need to know
how GitLab REST, GraphQL, `glab`, SQLite, or optional MCP tools are wired
behind it.

## Identity and assignment

The future stable identity entry point is `oflow identity --json` (or an
equivalent `auth whoami`). It must use GitLab's current-user endpoint and
report the GitLab principal, host, credential source, and backend capability
metadata without exposing credentials. `work --mine` must use that server
identity or a server-side `assignee=me` filter; local Git authors, model names,
agent names, and instruction-file emails are not GitLab identity.

Until that contract is implemented, a missing `User: Read` capability must be
reported as unavailable rather than guessed.

## Native packaging direction

The host-specific layer should remain thin:

- a Codex plugin may package skills, commands, and optional MCP wiring;
- an OMP extension may package native commands/skills and runtime-owned MCP;
- both must invoke `oflow` for identity, capabilities, plans, receipts, and
  verification instead of reimplementing GitLab requests;
- OpenWolf may preserve context, anatomy, memory, and handoff state, but must
  not persist GitLab tokens or replace remote verification.

The current `.omp/` bridge is the fallback installation path. Native packages
come after the P0 transport-truth and identity work, so all hosts share one
correct contract.

## GitHub Copilot and VS Code

`oflow install` creates `.github/copilot-instructions.md` when the repository
does not already have one. Existing content is preserved. The file points the
agent to the shared `.oflow/WORKFLOW.md` contract and the low-token CLI flow.

GitHub documents `.github/copilot-instructions.md` as a repository-wide
instruction location and also documents `AGENTS.md` for agent-specific
instructions. VS Code supports the repository-wide file, `AGENTS.md`, and
path-specific `.github/instructions/**/*.instructions.md` files. See the
official [Copilot instruction support matrix](https://docs.github.com/en/copilot/reference/custom-instructions-support)
and [VS Code custom instructions guide](https://code.visualstudio.com/docs/agent-customization/custom-instructions).

oflow deliberately does **not** create editor settings, MCP registrations,
Copilot credentials, or custom tool servers. A future adapter may integrate a
host's native tools, but it must preserve this boundary:

```text
agent host → oflow CLI JSON → local SQLite read model → GitLab adapter
                                      ↑
                              browser dashboard
                              (read-only, loopback)
```

An editor may run `oflow` in its terminal/task runner. An MCP server may also
be available to an agent, but it is optional and must not be treated as a
replacement for the checked-in workflow contract or `plan → approve → apply →
verify` safety lifecycle.

## Credential boundary

- GitLab tokens live in the user's credential store or an explicitly provided
  environment variable/stdin input.
- Tokens are never written to `.oflow`, SQLite, Git, editor settings, or
  instruction files.
- The dashboard imports only the local read-model module. It does not import
  auth or GitLab client code and never makes a remote request.
- A dashboard refresh button can only record a local refresh request. The
  explicit `oflow sync --refresh` CLI command is the only path that contacts
  GitLab for a refresh.

## Future adapter rules

When adding Copilot, VS Code, or another host adapter:

- consume the existing CLI JSON output instead of duplicating GitLab queries;
- keep cached reads offline and bounded;
- expose capability and permission requirements clearly;
- keep remote writes behind explicit plans and approvals;
- never pass raw tokens through prompts, browser APIs, or model-visible output;
- add adapter tests without making the core CLI depend on the host.
