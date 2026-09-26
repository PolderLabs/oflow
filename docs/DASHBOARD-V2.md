# Dashboard workspace

`oflow dashboard --open` serves a dependency-free local workspace for humans
supervising agent-assisted delivery. The original v2 endpoint contract is
preserved; the redesigned UI separates daily work from setup and diagnostics.
Visual and interaction decisions live in [`../DESIGN.md`](../DESIGN.md).

## Start and daily flow

1. Run `oflow sync --refresh` in the repository to populate the local read model.
2. Run `oflow dashboard --open` (default `http://127.0.0.1:4173/`).
3. Use Overview to inspect cache state and attention items.
4. Search/filter Work and copy a story command into your terminal or agent.
5. Inspect Delivery, Planning and Lifecycle as needed.

A missing snapshot is supported: the UI explains how to create it. Local view
reloads do not contact GitLab. Request sync records a local marker only; run
`oflow sync --refresh` yourself, then reload. There is no background sync worker.
CLI commands shown or copied by the UI are never executed by the browser.

## Views

| View | Evidence and interactions |
| --- | --- |
| Overview | Interactive Scrum work map, parent connections, item inspector, cached scope, attention items and sync history. |
| Work | Search and filters over cached work; ownership, labels, timeboxes and story-specific command handoffs. |
| Delivery | Cached merge requests and pipelines with safe GitLab links. |
| Planning | Iterations, milestones, board lists and labels from the snapshot. |
| Lifecycle | Local plans, verification state and audit events. Failed local reads are errors, not evidence of no plans. |
| Capabilities | Declarative catalog; optional explicit API probe. |
| Authentication | Redacted credential status and terminal login instructions. |
| Diagnostics | Explicit bounded read-only API check; no probe on navigation or page load. |
| Tour | Workflow orientation and safe CLI next steps. |

Views are hash-addressable (for example `/#work`), with browser back/forward
navigation. Small screens adapt navigation and content while tables scroll
inside their containers. Controls are keyboard accessible and status is text,
not color alone. Clipboard failures leave the command visible for selection.

## Interactive Overview map

The work map is a local, read-only visualization of the same `/api/data`
snapshot. It does not discover extra relationships or run new GitLab requests.

- Choose a board to arrange work by its labeled lists in configured order.
- Search cached items or filter by iteration, then select a card to inspect
  ownership, timebox and connected items, or copy context/assessment commands.
- Zoom and reset the scrollable canvas; keyboard users can activate cards as
  buttons and read the same relationships in the inspector.
- Arrows run **parent → child**. They are not dependency/blocker links and do
  not prove that an item moved through earlier Scrum stages.
- Internal parents are identified by matching resource URLs, not by issue
  number alone. An epic or another project can share the same number.
- Parents absent from the visible snapshot remain explicit reference nodes.
  Missing URLs are not evidence that two same-named parents are the same item.
- Unmapped items and conflicting board labels are not silently assigned a
  stage. Closed items are separate. Without a labeled board, the UI explains
  its conventional label-based stage mapping rather than inventing a board.
- Shared labels, owners and iterations describe grouping, not relationships.

The map preserves the existing snapshot coverage and unreadable-source notices.
No drag-and-drop updates, automatic stage transitions, or remote mutations are
introduced. Use the CLI’s guarded lifecycle to change work.

## Coverage and freshness

Snapshot data is bounded by the original CLI query, its filters and limits.
The dashboard is not a project-wide inventory. `/api/data` includes `query`,
`workItemsMayBeTruncated`, and `planningHealth` alongside the existing data.
The query/health values are null without a sync snapshot; fallback work-item
reads are conservatively marked possibly truncated when their 100-row limit
is reached. Counts in the UI describe displayed snapshot arrays, rather than
cumulative SQLite table counts.

Invalidation and pending refresh markers are distinct from snapshot age. A
recent snapshot is not a remote-write precondition. Warnings beginning with
"Could not read" describe unavailable sources; advisory warnings remain
separate. A zero from an unreadable source must not imply absence in GitLab.

## Trust boundary

- Bind only to `127.0.0.1`; no LAN bind option.
- No token input, browser token storage, or token response fields.
- Credential setup/clearing remains a terminal operation.
- A browser cannot supply the host used by credentialed operations. The server
  resolves it from the repository Git remote.
- No implicit remote API calls. The explicit check/probe invokes the bounded
  read-only doctor in the server process; credentials never reach the browser.
- No remote mutations or arbitrary command execution routes.
- Escape remote text centrally; outbound links accept only HTTP(S).
- Reject foreign `Origin` headers, including on ephemeral ports. No CORS.
- Responses use `no-store`, `nosniff`, and a self-only default CSP. Embedded
  styles/scripts are allowed; no third-party assets are loaded.

## HTTP surface

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/` | Embedded application shell. |
| GET | `/api/data` | Cached project, work, delivery, planning, query coverage, warnings and history. |
| GET | `/api/status` | Read-model state, age, invalidation and refresh request. |
| POST | `/api/refresh` | Records a local request; returns the CLI refresh instruction. No GitLab call. |
| GET | `/api/capabilities` | Declarative catalog without probing. |
| POST | `/api/check-api` | Explicit server-side `doctor({checkApi: true})`; sanitized results. |
| GET | `/api/auth/status` | Credential source and redacted storage location, never a token. |
| POST | `/api/auth/request` | `{action: "login" \| "clear"}`; returns terminal instructions with `applied: false`. A supplied `host` is rejected. |
| GET | `/api/plans` | Local plan summaries. |
| GET | `/api/verification` | Current local verification status. |
| GET | `/api/audit` | Recent local audit events. |

Auth requests do not launch a prompt, clear credentials, or create a bridge.
Token entry and clearing use `oflow auth login` / `oflow auth clear` in the
terminal. Doctor responses use an explicit allowlist, omit the raw remote URL,
and redact the local root. This is not a generic sanitization promise for
arbitrary strings in user-authored project data.

## Cross-platform and troubleshooting

`--open` uses the platform browser opener and does not fail the server if the
opener is unavailable. Open the printed URL manually in that case. `--port 0`
selects a free port and validates browser Origin against the actual bound
port. On WSL the printed loopback address can be forwarded by the host.

If a view fails, check its error, rerun the suggested CLI command if appropriate,
and reload local data. For GitLab access failures use Authentication and an
explicit Diagnostics check. Never paste credentials into the dashboard.

## Development validation

Run `npm test`, `npm run typecheck`, `npm run check:public`, and
`npm pack --dry-run`. Dashboard tests cover escaped data, snapshot coverage,
local endpoint boundaries and view behavior. Browser checks should use only
synthetic fixtures, with desktop and mobile widths, all navigation destinations,
filtering, empty/error states and command handoffs.

### Guided agent handoff

Overview includes an explicit cached-story selector and explained start, assess,
and handoff commands. Each action states when to use it and what it returns.
Nothing runs from the copy controls; users run commands in their repository
terminal and share the resulting output. Assessment does not run tests and a
handoff does not approve changes. Refresh helpers remain separately disclosed.
