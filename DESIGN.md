# Design

## Source of truth
Status: Active. Updated: 2026-09-26. Surface: `oflow dashboard`.
Evidence: README.md, src/dashboard-view.ts, src/dashboard.ts,
src/read-model.ts, src/sync.ts, and dashboard regression tests. No existing
visual baseline or brand asset library was supplied.

## Brand
A calm, precise workspace for agent-assisted GitLab delivery. Warm neutral
canvas, dark navigation, restrained teal accents. Trust comes from visible
snapshot age, honest coverage, and explicit action boundaries, not decoration.
Avoid fabricated activity, vanity charts, gradients, and live-status claims.

## Product goals
Help a developer identify the next story, understand delivery failures, review
planning, and inspect local write/verification evidence in one place.
Success: find and filter cached work, copy its CLI context command, inspect
pipelines and planning, and understand when a fresh CLI sync is needed.
Non-goals: a GitLab replacement, browser credential entry, arbitrary command
execution, remote writes, or automatic API probing. Explicit server-side actions
may fetch GitLab context or run already-configured repository checks.

## Personas and jobs
Developers supervising coding agents: orient at session start, select work,
check delivery, and review safe handoffs. Maintainers: diagnose auth and
capabilities without exposing credentials.

## Information architecture
Overview is an interactive work map followed by summary and next-action evidence. Work contains searchable work
items and story handoffs. Delivery exposes MRs and pipelines. Planning exposes
iterations, milestones, boards and labels. Lifecycle, Capabilities,
Authentication, Diagnostics and Tour retain the existing support surfaces.
Hash navigation supports browser history and direct links.

## Design principles
Useful evidence before decoration. Distinguish absent data from unreadable
sources. Counts describe cached, bounded results, not project-wide totals.
Separate refreshing the local view from contacting GitLab. Preserve existing
security behavior and workflow gates while improving presentation.

## Visual language
System sans-serif typography and monospace commands; no font downloads.
Warm off-white background, white panels, dark ink, muted secondary copy,
teal actions. Consistent 4/8px spacing rhythm, modest radii and subtle borders.
Readable dense tables, generous section spacing, no ornamental imagery.

## Components
Responsive sidebar/navigation, page heading and actions, snapshot status,
metric cards, attention list, filter toolbar, work rows/details, status badges,
copy-command controls, empty states, scrollable tables and inline errors.
CSS tokens are owned by src/dashboard-view.ts; the map module reuses them.
The map uses keyboard-operable item cards, SVG parent connectors, stage lane
headings, a board selector, search/iteration filters, zoom/reset, and a selected
item inspector with equivalent textual relationships.

## Accessibility
Target WCAG 2.2 AA: semantic headings, named controls, visible focus, keyboard
navigation, readable contrast, and text labels for status (not color alone).
Announce action results; honor reduced motion. No hover-only functionality.

## Responsive behavior
Desktop sidebar with flexible main content. Compact screens use wrapping or
scrollable navigation, single-column content and bounded table scrolling.
Controls remain touch-friendly. No page-level horizontal overflow.

## Interaction states
Show loading during local reads; retain actionable empty states for missing
snapshots. Display API failures as errors, not empty results. Distinguish stale,
requested refresh and unavailable data. A command copy never executes it.
Clipboard failure must leave a visible command for manual selection.

## Content voice
Short, specific and truthful. Use "cached", "snapshot", "Run in terminal"
and "Request sync" deliberately. Never imply approval or verification from
cached project data. No credential input in any browser view.

## Implementation constraints
Dependency-free, embedded HTML/CSS/JS served by the existing loopback server.
No CDN, external assets, runtime frontend framework or new npm dependencies.
Escape all remote text and allow only HTTP(S) outbound links. Reads remain
local; API checks require an explicit action. Preserve plan → approve → apply
→ verify. Test rendering, filtering, malicious data, stale/empty state,
navigation and existing API boundaries. Validate desktop/mobile in a browser
when a local browser is available; screenshots must use synthetic fixtures.

## Work map semantics
The Overview map is a bounded snapshot, not dependency discovery or historical
flow. Horizontal lanes describe board-list order, not evidence that work has
moved through each stage. Use the selected board’s labels; items matching
multiple lists are ambiguous and items matching none remain unmapped. Closed
items have their own lane. When no labeled board exists, disclose the use of
conventional label-based stages rather than claiming a configured workflow.
Parent arrows mean parent → child only. Resolve internal parents by resource
URL, never issue number alone: epic and issue numbers can collide across
resources/projects. Unresolved parents remain distinct reference nodes with
explicit missing/outside-snapshot status. Shared labels, owners and timeboxes
are filters/groupings, not edges. Filtering must not hide the fact that a
relation endpoint is outside the visible scope. Handle cycles without recursive
layout. No draggable status changes or remote writes.

## Overview guidance
Stage controls expose the entire configured order without requiring canvas panning.
Counts follow search/iteration scope; stage focus preserves parent-reference context.
Unmapped and closed are separate classifications, not extra delivery steps.
The agent handoff panel explains when to use each command and its output.
Select a cached story explicitly; never silently pick work for the user.
Copying only copies a command: terminal reads may contact GitLab, and handing
off requires sharing the resulting output with the next agent.

## Connected delivery workspace
Story routes unify exact-story evidence, parent relationships, context and handoff
previews. Initial navigation is local-only; missing descriptions or criteria are
unknown until explicitly loaded. Never associate global pipelines with a story
without recorded evidence. Briefs distinguish cached observations, assessment
evidence and unknowns; comparisons describe stored brief changes, not GitLab events.

Dashboard actions use a fixed allowlist and an explicit user click. Show running,
succeeded, failed and cancelled states, timestamps, output and cancellation.
Configured checks run repository code; disclose this before launch. No browser
command input, credentials or approval bypass. Recommendations show evidence,
time and reason. Activity distinguishes local executions from GitLab observations.

Board/map modes share filters. Stage WIP limits and entry/exit guidance are
explicit browser-local policies scoped to project and board, not remote settings
or enforced gates. WIP comparisons use the full bounded cache, not a filtered
subset. No stage-duration analytics without actual transition evidence.

## Open questions
None blocking. Design assumes a developer-focused light workspace rather than
a configurable theme; dark mode and remote mutation controls are out of scope.
