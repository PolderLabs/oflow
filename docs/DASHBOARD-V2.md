# Dashboard v2

`oflow dashboard` is the human-facing surface of the local read model. v2 turns
the single-view page into a small multi-view application and adds an
authentication path, an API capability check, and a capabilities catalog — all
without ever handing a GitLab token to the browser.

## Trust boundary

The invariant from [`GITLAB-INTEGRATION.md`](GITLAB-INTEGRATION.md) holds: a
browser never receives GitLab token material, and the browser never supplies
the host that credentialed requests target.

| Rule | Enforcement |
| --- | --- |
| Loopback only, no LAN bind | `startDashboard` builds `http://127.0.0.1:<port>/`; there is deliberately no `--host` bind flag. |
| No token in any HTTP response or DOM | No response field carries token material. `redactLocalPath` strips home paths; `sanitizeDoctorReport` reduces the doctor report to booleans, enums, and statuses. |
| No token in the browser | The browser never sends a token. Token entry stays a terminal prompt, exactly like `oflow auth login`. |
| Host is resolved server-side | `POST /api/auth/request` accepts an action only. The host comes from the repository's Git remote via `resolveAuthHost`, the same source `oflow auth` uses. A browser-supplied host is rejected. |
| No implicit remote calls on page load | Capability probes and API checks run only on an explicit user action. |
| Cross-origin requests rejected | Every mutating route validates `Origin`. No CORS headers are ever set. |

### Where credentialed work actually runs

The dashboard process is a long-lived local process, and it resolves a token
locally when the user explicitly asks for an API check. `doctor` and
`resolveAuth` read the same machine-local credential store the CLI already
uses. That is the point of the boundary: token material stays inside a
loopback server process and the local config directory. It is never
transmitted to the browser, never written into a response body, and never
reachable by a remote page.

The original v2 draft proposed a file-mediated `--auth-bridge` so that token
entry would happen in a separate process. That was rejected: it added two
files, a polling loop, and a second lifecycle for a UX that a terminal prompt
already provides. Authentication from the browser is therefore **action-only**:
the browser asks the server to do the same work `oflow auth login` does, and
the user completes the token entry in their terminal.

```text
browser  POST /api/auth/request  {action: "login"|"clear"}
              |  (action only; host resolved server-side from the Git remote)
              v
        dashboard process -> same credential store + probe as `oflow auth`
              |
              v
        200 {action, host, activeSource, storedForHost}   (no token)
```

Because the browser cannot type a token, the Auth view tells the user to run
`oflow auth login` in their terminal and then re-check. The server-side action
exists for scripted and non-interactive use; it never widens what a page in
the browser can reach.

The request body is `{action: "login" | "clear"}` and nothing else. A `host`
field in the body is rejected. Both actions resolve the host from the
repository's Git remote, so the dashboard cannot be pointed at an arbitrary
GitLab instance by a page that reaches the loopback port.

### Cross-origin defence

A loopback server is reachable by any page the user visits, so every mutating
route validates the `Origin` header. A request with no `Origin` (the CLI) or
with an origin equal to the server's own `http://127.0.0.1:<port>` is allowed;
any other origin is rejected with 403. No CORS headers are set, so a foreign
page cannot read a response even when it can send a request.

## HTTP surface

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | `/` | Single-page app shell. |
| GET | `/api/data` | Local read model: project, work items, MRs, pipelines, iterations, planning, sync history. |
| GET | `/api/status` | Read-model status and cache age. |
| POST | `/api/refresh` | Records a local refresh request for the CLI. Never calls GitLab. |
| GET | `/api/capabilities` | Declarative catalog from `getCapabilities()` with probing off. No network. |
| POST | `/api/check-api` | Runs `doctor({checkApi: true})` server-side, then returns a sanitized report. Explicit user action only. |
| GET | `/api/auth/status` | Redacted auth status. Never a token. |
| POST | `/api/auth/request` | `{action}` only; host resolved server-side. Rejects a supplied host. |
| GET | `/api/plans` | Local plan lifecycle summary. |
| GET | `/api/verification` | Repository verification status for the current tree. |
| GET | `/api/audit` | Recent plan audit events. |

All responses set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
and a `default-src 'self'` content security policy.

## Views

1. **Overview** — metrics, work items, MRs, delivery and planning, sync history.
2. **Capabilities** — the catalog with access, state, backend, and permission,
   plus a probe-driven run and its transport lifecycle.
3. **Auth** — status, stored hosts, active source, and the terminal command to
   run. No token input, ever.
4. **Diagnostics** — the sanitized `doctor` report: per-capability status,
   latency, transport state, and warnings.
5. **Lifecycle** — local plans, repository verification, and audit events.
6. **Tour** — a short capability showcase so the surface explains itself to
   someone who has never run `oflow`.

## Cross-platform ergonomics

`--open` launches the default browser using the platform's own opener
(`open` on macOS, `start` on Windows, `xdg-open` on Linux and WSL) and never
fails the command if the opener is missing. On WSL the printed URL stays
`127.0.0.1`, which WSL forwards to the Windows host.

## Redaction

`redactLocalPath` collapses a leading home directory to `~` and falls back to a
basename for anything else. `sanitizeDoctorReport` replaces the absolute
repository root with its redacted form and drops any secret-looking field. Both
run on every value that crosses the HTTP boundary, so a browser never displays
a machine-specific home directory. Both are unit-tested because the invariant
is user-visible, not merely internal.
| POST | `/api/refresh` | Records a local refresh request for the CLI. Never calls GitLab. |
| GET | `/api/capabilities` | Declarative catalog from `getCapabilities()` with probing off. No network. |
| POST | `/api/check-api` | Runs `doctor({checkApi: true})`. Explicit user action only. |
| GET | `/api/auth/status` | Redacted auth status. Never a token. |
| POST | `/api/auth/request` | Records a bridge request. `bridgeRequired` when no bridge. |
| GET | `/api/plans` | Local plan lifecycle summary. |
| GET | `/api/verification` | Repository verification status for the current tree. |
| GET | `/api/audit` | Recent plan audit events. |

All responses set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
and a `default-src 'self'` content security policy.

## Views

1. **Overview** — metrics, work items, MRs, delivery and planning, sync history.
2. **Capabilities** — the catalog with access, state, backend, and permission,
   plus a probe-driven run and its transport lifecycle.
3. **Auth** — status, stored hosts, active source, and the connect/clear bridge.
4. **Diagnostics** — `doctor --check-api` results: per-capability status,
   latency, transport state, and warnings.
5. **Lifecycle** — local plans, repository verification, and audit events.
6. **Guided tour** — a short capability showcase so the surface explains itself
   to someone who has never run `oflow`.

## Cross-platform ergonomics

`--open` launches the default browser using the platform's own opener
(`open` on macOS, `start` on Windows, `xdg-open` on Linux and WSL) and never
fails the command if the opener is missing. On WSL the printed URL stays
`127.0.0.1`, which WSL forwards to the Windows host.

## Redaction

`redactLocalPath` collapses a leading home directory to `~` and falls back to a
basename for anything else. Every path that crosses the HTTP boundary is
passed through it, so a browser never displays a machine-specific home
directory. The helper is unit-tested because the invariant is user-visible, not
merely internal.
