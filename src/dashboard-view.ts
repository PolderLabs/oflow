/**
 * Single-page dashboard shell served from `GET /`.
 *
 * Plain inline HTML/CSS/JS: no bundler, no CDN, no cross-origin request. The
 * page only ever talks to this process on 127.0.0.1, and the API never returns
 * token material, so no secret ever reaches the DOM.
 */
export function dashboardViewHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>oflow cockpit</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      --bg: #0d1017; --bg-glow: #1b2333; --panel: #161b25; --panel-2: #1b212e;
      --line: #29313f; --line-soft: #212936;
      --text: #eef1f7; --muted: #aab4c7; --dim: #7f8a9e;
      --accent: #6ea8fe; --accent-soft: rgba(110,168,254,.14);
      --ok: #57d9a3; --warn: #f2c14e; --bad: #f2777a;
      --radius: 12px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; color: var(--text);
      background:
        radial-gradient(1100px 620px at 82% -12%, var(--bg-glow), transparent 62%),
        radial-gradient(760px 520px at -8% 108%, #171d29, transparent 58%),
        var(--bg);
      background-attachment: fixed;
    }
    .shell { display: grid; grid-template-columns: 244px minmax(0, 1fr); min-height: 100vh; }
    nav {
      border-right: 1px solid var(--line); padding: 24px 14px; position: sticky; top: 0;
      height: 100vh; overflow-y: auto; background: rgba(11,14,20,.72);
      backdrop-filter: blur(8px);
    }
    nav .brand {
      font-size: 1.4rem; font-weight: 700; letter-spacing: -.03em;
      display: flex; align-items: center; gap: 9px; padding: 0 10px;
    }
    nav .brand::before {
      content: ""; width: 9px; height: 9px; border-radius: 3px;
      background: linear-gradient(140deg, var(--accent), #9b7bff);
      box-shadow: 0 0 14px rgba(110,168,254,.55);
    }
    nav .tag { color: var(--dim); font-size: .76rem; margin: 3px 0 20px 28px; letter-spacing: .04em; text-transform: uppercase; }
    nav button {
      display: block; width: 100%; text-align: left; background: none; border: 0;
      border-left: 2px solid transparent; color: var(--muted); padding: 9px 12px;
      border-radius: 0 8px 8px 0; cursor: pointer; font-size: .93rem; font-weight: 500;
      margin-bottom: 2px; transition: background .12s ease, color .12s ease;
    }
    nav button:hover { background: rgba(255,255,255,.045); color: var(--text); }
    nav button[aria-selected="true"] {
      background: linear-gradient(90deg, var(--accent-soft), transparent 85%);
      border-left-color: var(--accent); color: #fff; font-weight: 600;
    }
    main { padding: 30px 28px 72px; min-width: 0; }
    main > section, main > div > section { max-width: 1240px; }
    header {
      display: flex; justify-content: space-between; gap: 18px; align-items: flex-end;
      margin-bottom: 22px; flex-wrap: wrap; padding-bottom: 16px;
      border-bottom: 1px solid var(--line-soft);
    }
    h1 { margin: 0; font-size: clamp(1.5rem, 2.6vw, 1.95rem); letter-spacing: -.035em; font-weight: 700; }
    h2 {
      margin: 0 0 14px; font-size: .72rem; color: var(--dim); font-weight: 600;
      text-transform: uppercase; letter-spacing: .1em;
    }
    p { color: var(--muted); line-height: 1.55; }
    header p { margin: 6px 0 0; max-width: 68ch; }
    button.action {
      cursor: pointer; border: 1px solid #42527a; border-radius: 999px; padding: 8px 15px;
      color: #eef3ff; background: #25314a; font-size: .88rem; font-weight: 500;
      transition: background .12s ease, border-color .12s ease;
    }
    button.action:hover:not(:disabled) { background: #31405e; border-color: #56699a; }
    button.action:disabled { opacity: .5; cursor: progress; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(178px, 1fr)); gap: 12px; }
    .card, section {
      border: 1px solid var(--line); background: var(--panel);
      border-radius: var(--radius); padding: 16px 18px;
      box-shadow: 0 1px 2px rgba(0,0,0,.28), 0 10px 26px -18px rgba(0,0,0,.9);
    }
    section { margin-top: 16px; }
    .card {
      display: flex; flex-direction: column; gap: 3px; position: relative; overflow: hidden;
      border-left: 2px solid var(--line);
    }
    .card::after {
      content: ""; position: absolute; inset: 0 0 auto 0; height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.07), transparent);
    }
    .metric {
      font-size: 2rem; font-weight: 700; line-height: 1.1; letter-spacing: -.03em;
      color: var(--text); font-variant-numeric: tabular-nums;
    }
    .card-label {
      font-size: .8rem; font-weight: 500; color: var(--muted);
      text-transform: uppercase; letter-spacing: .06em;
    }
    .card-note { color: var(--dim); font-size: .8rem; margin-top: 2px; }
    .card-note.gap { color: var(--warn); }
    .gap-list { margin: 0; padding-left: 18px; color: var(--muted); font-size: .86rem; }
    .gap-list li { margin: 5px 0; line-height: 1.5; word-break: break-word; }
    .muted { color: var(--dim); font-size: .86rem; }
    .badge {
      display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: .72rem;
      font-weight: 500; border: 1px solid var(--line); color: var(--muted); margin-right: 5px;
    }
    .badge.ok { color: var(--ok); border-color: #2c5c48; background: rgba(87,217,163,.09); }
    .badge.warn { color: var(--warn); border-color: #5d4c22; background: rgba(242,193,78,.09); }
    .badge.bad { color: var(--bad); border-color: #6b3437; background: rgba(242,119,122,.09); }
    .badge.live { color: var(--accent); border-color: #35507d; background: rgba(110,168,254,.1); }
    .table-wrap {
      max-height: 560px; overflow: auto; border: 1px solid var(--line-soft);
      border-radius: 10px; scrollbar-width: thin;
    }
    table { width: 100%; border-collapse: separate; border-spacing: 0; }
    th, td { text-align: left; padding: 9px 12px; vertical-align: top; }
    thead th {
      position: sticky; top: 0; z-index: 1; color: var(--dim);
      font-size: .71rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em;
      background: var(--panel-2); border-bottom: 1px solid var(--line);
    }
    tbody td { border-bottom: 1px solid var(--line-soft); font-size: .89rem; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover td { background: rgba(110,168,254,.055); }
    tbody tr:nth-child(even) td { background: rgba(255,255,255,.012); }
    tbody tr:hover:nth-child(even) td { background: rgba(110,168,254,.075); }
    td.num, th.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre {
      background: #0b0e14; border: 1px solid var(--line-soft); border-radius: 9px;
      padding: 12px 14px; overflow-x: auto; color: #cfe0ff; font-size: .84rem; line-height: 1.5;
    }
    .hidden { display: none; }
    #notice { min-height: 1.4em; margin-bottom: 10px; color: var(--accent); font-size: .9rem; }
    #banner { margin-bottom: 14px; border-radius: 10px; padding: 11px 14px; font-size: .9rem; }
    #banner.bad { color: var(--bad); background: rgba(242,119,122,.1); border: 1px solid #6b3437; }
    .tour-step { border-left: 3px solid var(--accent); padding-left: 14px; margin-bottom: 16px; }
    .tour-step h3 { margin: 0 0 5px; font-size: 1rem; }
    @media (max-width: 880px) {
      .shell { grid-template-columns: 1fr; }
      nav {
        position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line);
        display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 14px;
      }
      nav .brand, nav .tag { margin: 0 10px 0 0; }
      nav .tag { display: none; }
      nav button {
        width: auto; border-left: 0; border-bottom: 2px solid transparent;
        border-radius: 8px; padding: 7px 11px;
      }
      nav button[aria-selected="true"] {
        background: var(--accent-soft); border-left-color: transparent;
        border-bottom-color: var(--accent);
      }
      main { padding: 20px 16px 56px; }
      .table-wrap { max-height: 420px; }
    }
  </style>
</head>
<body>
<div class="shell">
  <nav aria-label="Dashboard views">
    <div class="brand">oflow</div>
    <div class="tag">local cockpit</div>
    <div id="tabs"></div>
  </nav>
  <main>
    <header>
      <div>
        <h1 id="view-title">Overview</h1>
        <p id="subtitle" class="muted">Local read model. No GitLab token ever reaches this page.</p>
      </div>
      <div id="view-actions"></div>
    </header>
    <div id="banner" class="hidden" role="alert"></div>
    <div id="notice" role="status"></div>
    <div id="view"></div>
  </main>
</div>
<script>
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const link = (title, url) => url ? '<a href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(title) + '</a>' : esc(title);
const age = (seconds) => seconds == null ? 'unknown' : seconds < 60 ? 'under a minute' : Math.floor(seconds / 60) + 'm ago';
/* A machine timestamp like 2026-09-25T19:55:52.897+02:00 is 246px of a
 * ~1365px viewport. Parse defensively: anything unparseable, empty, or in the
 * future is passed through unchanged and still escaped by cell(). */
const when = (value) => {
  if (!value) return '';
  const then = Date.parse(value);
  if (Number.isNaN(then)) return value;
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 0) return value;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  if (seconds < 2592000) return Math.floor(seconds / 86400) + 'd ago';
  return value.slice(0, 10);
};

const VIEWS = [
  { id: 'overview', label: 'Overview', title: 'Overview',
    subtitle: 'Cached planning state read from the local SQLite read model.' },
  { id: 'capabilities', label: 'Capabilities', title: 'Capabilities',
    subtitle: 'What oflow can do here, and which of those are actually usable with your token.' },
  { id: 'auth', label: 'Auth', title: 'Authentication',
    subtitle: 'Token state only. Token entry happens in your terminal, never in this page.' },
  { id: 'diagnostics', label: 'Diagnostics', title: 'Diagnostics',
    subtitle: 'Live API check. Runs only when you ask, never on page load.' },
  { id: 'lifecycle', label: 'Lifecycle', title: 'Lifecycle',
    subtitle: 'Local plans, repository verification, and the audit trail.' },
  { id: 'tour', label: 'Tour', title: 'What oflow does',
    subtitle: 'A short tour of the workflow if this is your first run.' },
];

const notice = (text) => { document.getElementById('notice').textContent = text || ''; };
const banner = (text) => {
  const el = document.getElementById('banner');
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.className = 'bad';
  el.textContent = text;
};
const busy = (button, isBusy, label) => {
  button.disabled = isBusy;
  button.textContent = isBusy ? 'Working…' : label;
};

async function api(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (error) { data = { error: text }; }
  if (!response.ok) throw new Error((data && data.error) || ('Request failed: ' + response.status));
  return data;
}

/* Cells are escaped here, not by the caller: table rows carry GitLab-controlled
 * strings (project paths, issue titles, capability notes, doctor details), so one
 * forgotten esc() at a single call site would otherwise inject script into a
 * localhost page. A cell that genuinely needs markup opts in via rawCell(). */
/* A Symbol tag, not a string key: any API response is JSON, so a
 * {"__html": "<img onerror=...>"} field in a GitLab-sourced string would
 * otherwise be auto-promoted to raw markup without ever calling rawCell(). */
const RAW = Symbol('raw');
const rawCell = (html) => ({ [RAW]: html });
const cell = (value) => (value !== null && typeof value === 'object' && value[RAW] !== undefined
  ? value[RAW]
  : esc(value));
const table = (headers, rows) =>
  '<div class="table-wrap"><table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') +
  '</tr></thead><tbody>' + rows.map((cells) =>
    '<tr>' + cells.map((entry) => '<td>' + cell(entry) + '</td>').join('') + '</tr>').join('') +
  '</tbody></table></div>';

/* Number, label, and caption are distinct elements so a card never reads as
 * one run-on string like "100Work itemsunder a minute". */
const metric = (label, value, note, noteClass) =>
  '<div class="card"><div class="metric">' + esc(value) + '</div>' +
  '<div class="card-label">' + esc(label) + '</div>' +
  (note ? '<div class="card-note' + (noteClass ? ' ' + noteClass : '') + '">' + esc(note) + '</div>' : '') +
  '</div>';

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.replaceChildren();
  for (const view of VIEWS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = view.label;
    button.setAttribute('aria-selected', String(view.id === activeView));
    button.addEventListener('click', () => { location.hash = view.id; });
    tabs.append(button);
  }
}

let activeView = 'overview';

async function renderOverview(host) {
  const data = await api('/api/data');
  const status = data.status || {};
  const counts = status.counts || {};
  const project = data.project;
  // A source the token could not read yields an empty list, which is
  // indistinguishable from "none exist". Say so rather than let the cockpit
  // claim the project has no pipelines.
  const gaps = Array.isArray(data.warnings) ? data.warnings : [];
  const gapNote = gaps.length
    ? gaps.length + ' source' + (gaps.length === 1 ? '' : 's') + ' not readable with this token'
    : '';
  const sourceGap = gaps.length
    ? '<section><h2>Data sources this token cannot read</h2>' +
      '<p class="muted">Counts above are not evidence of absence for these:</p><ul class="gap-list">' +
      gaps.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></section>'
    : '';
  const metrics = [
    metric('Work items', counts.workItems ?? 0,
      status.latestSync ? age(status.latestSync.ageSeconds) : 'no snapshot yet'),
    metric('Merge requests', counts.mergeRequests ?? 0),
    metric('Pipelines', counts.pipelines ?? 0, gapNote || undefined, gaps.length ? 'gap' : ''),
    metric('Iterations', counts.iterations ?? 0),
    metric('Snapshots', counts.syncSnapshots ?? 0),
    metric('Read model', status.state ?? 'unknown',
      status.databaseExists ? 'sqlite ready' : 'not created yet'),
  ];
  const workRows = (data.workItems || []).map((item) => [
    rawCell(link('#' + item.iid + ' ' + item.title, item.webUrl)),
    item.state,
    item.type || '',
    item.assignee || 'unassigned',
    when(item.updatedAt),
  ]);
  const mrRows = (data.mergeRequests || []).map((mr) => [
    rawCell(link('!' + mr.iid + ' ' + (mr.title || ''), mr.webUrl)),
    mr.state,
    mr.sourceBranch || '',
    when(mr.updatedAt),
  ]);
  const planning = data.planning || {};
  host.innerHTML =
    (project ? '<section><h2>Project</h2><p>' + esc(project.host) + ' / ' + esc(project.path) +
      (data.repository && data.repository.branch ? ' · ' + esc(data.repository.branch) : '') + '</p></section>' : '') +
    '<div class="grid">' + metrics.join('') + '</div>' +
    sourceGap +
    '<section><h2>Work items</h2>' +
      (workRows.length ? table(['Item', 'State', 'Type', 'Assignee', 'Updated'], workRows) : '<p class="muted">No cached work items.</p>') +
    '</section>' +
    '<section><h2>Merge requests</h2>' +
      (mrRows.length ? table(['MR', 'State', 'Branch', 'Updated'], mrRows) : '<p class="muted">No cached merge requests.</p>') +
    '</section>' +
    '<section><h2>Delivery and planning</h2><div class="grid">' +
      metric('Labels', (planning.labels || []).length) +
      metric('Milestones', (planning.milestones || []).length) +
      metric('Boards', (planning.boards || []).length) +
      '</div></section>' +
    '<section><h2>Sync history</h2>' +
      (data.syncHistory && data.syncHistory.length
        ? table(['Generated', 'Branch', 'Source', 'Warnings'], data.syncHistory.map((entry) => [
            when(entry.generatedAt), entry.branch || '', entry.source || '', entry.warningCount,
          ]))
        : '<p class="muted">No sync history yet. Run <code>oflow sync --refresh</code>.</p>') +
    '</section>';
}

async function renderCapabilities(host) {
  const data = await api('/api/capabilities');
  const rows = data.capabilities || [];
  const badgeFor = (capability) =>
    '<span class="badge ' + (capability.state === 'implemented' ? 'live' : '') + '">' + esc(capability.state) + '</span>' +
    '<span class="badge">' + esc(capability.access) + '</span>' +
    '<span class="badge">' + esc(capability.backend) + '</span>' +
    (capability.permission ? '<span class="badge warn">' + esc(capability.permission) + '</span>' : '');
  const groups = [
    { key: 'implemented', label: 'Implemented', note: 'Available with this release.' },
    { key: 'optional', label: 'Optional', note: 'Works when a backend or runtime is present.' },
    { key: 'planned', label: 'Planned', note: 'Not available yet.' },
  ];
  const sections = groups.map((group) => {
    const members = rows.filter((capability) => capability.state === group.key);
    if (!members.length) return '';
    return '<section><h2>' + esc(group.label) + ' · ' + esc(String(members.length)) + '</h2>' +
      '<p class="muted">' + esc(group.note) + '</p>' +
      table(['Capability', 'Resource', 'Access / backend / permission', 'Notes'],
        members.map((capability) => [
          rawCell('<code>' + esc(capability.id) + '</code>'),
          capability.resource || '',
          rawCell(badgeFor(capability)),
          capability.note || '',
        ])) + '</section>';
  }).join('');
  host.innerHTML = sections || '<p class="muted">No capabilities reported.</p>';
  document.getElementById('view-actions').innerHTML =
    '<button class="action" id="probe" type="button">Run capability probe</button>';
  document.getElementById('probe').addEventListener('click', runProbe);
}

async function runProbe(event) {
  const button = event.currentTarget;
  busy(button, true, 'Run capability probe');
  banner('');
  try {
    const report = await api('/api/check-api', { method: 'POST' });
    const checks = report.apiChecks || [];
    const failed = checks.filter((check) => check.status === 'failed');
    notice(failed.length
      ? failed.length + ' of ' + checks.length + ' capability checks failed.'
      : 'All ' + checks.length + ' capability checks passed.');
  } catch (error) {
    banner('Capability probe failed: ' + esc(error.message));
  } finally {
    busy(button, false, 'Run capability probe');
  }
}

async function renderAuth(host) {
  const status = await api('/api/auth/status');
  const stored = (status.storedHosts || []).map((h) => '<span class="badge">' + esc(h) + '</span>').join(' ') ||
    '<span class="muted">none</span>';
  host.innerHTML =
    '<section><h2>Token state</h2>' + table(['Field', 'Value'], [
      ['Host', rawCell('<code>' + esc(status.host || 'unresolved') + '</code>')],
      ['Active source', rawCell('<span class="badge ' + (status.activeSource ? 'ok' : 'warn') + '">' + esc(status.activeSource || 'none') + '</span>')],
      ['Stored for this host', status.storedForHost ? 'yes' : 'no'],
      ['Known hosts', rawCell(stored)],
      ['Credentials file', rawCell('<code>' + esc(status.credentialsFile || 'unavailable') + '</code>')],
    ]) + '</section>' +
    '<section><h2>Connect</h2>' +
      '<p>This page never accepts a token. Run the command below in your terminal, then reload this view.</p>' +
      '<pre>' + esc(status.loginCommand || 'cd into the GitLab repository, then run: oflow auth login') + '</pre>' +
      '<p class="muted">oflow keeps the token in its own config directory, outside the repository, and never sends it to this page.</p>' +
    '</section>';
  document.getElementById('view-actions').innerHTML =
    '<button class="action" id="recheck" type="button">Re-check status</button>';
  document.getElementById('recheck').addEventListener('click', () => { void show(activeView); });
}

async function renderDiagnostics(host) {
  host.innerHTML = '<p class="muted">Run a live API check to see which capability calls actually succeed with your token.</p>';
  const button = document.createElement('button');
  button.className = 'action';
  button.type = 'button';
  button.textContent = 'Run API check';
  button.addEventListener('click', () => { void runDiagnostics(host, button); });
  host.append(button);
}

async function runDiagnostics(host, button) {
  busy(button, true, 'Run API check');
  banner('');
  try {
    const report = await api('/api/check-api', { method: 'POST' });
    const statusClass = { passed: 'ok', failed: 'bad', skipped: 'warn', 'not-probed': '' };
    const checks = (report.apiChecks || []).map((check) => [
      rawCell('<code>' + esc(check.id) + '</code>'),
      rawCell('<span class="badge ' + (statusClass[check.status] || '') + '">' + esc(check.status) + '</span>'),
      check.backend,
      check.required ? 'required' : 'optional',
      check.latencyMs == null ? '' : String(check.latencyMs) + ' ms',
      check.detail,
    ]);
    const transport = report.transport;
    host.innerHTML =
      (transport ? '<section><h2>Transport</h2>' + table(['Host', 'State', 'Reduced'], [[
        rawCell('<code>' + esc(transport.host) + '</code>'),
        transport.state == null ? '' : JSON.stringify(transport.state),
        transport.reduced ? 'yes' : 'no',
      ]]) + '</section>' : '') +
      '<section><h2>Capability checks</h2>' +
        (checks.length ? table(['Capability', 'Status', 'Backend', 'Need', 'Latency', 'Detail'], checks)
          : '<p class="muted">No checks were run.</p>') + '</section>' +
      '<section><h2>Warnings</h2>' +
        ((report.warnings || []).length
          ? '<ul>' + report.warnings.map((w) => '<li class="muted">' + esc(w) + '</li>').join('') + '</ul>'
          : '<p class="muted">No warnings.</p>') + '</section>';
    notice('API check complete: ' + report.apiCheck + '.');
  } catch (error) {
    banner('API check failed: ' + esc(error.message));
  } finally {
    busy(button, false, 'Run API check');
  }
}

async function renderLifecycle(host) {
  const [plans, verification, audit] = await Promise.all([
    api('/api/plans').catch(() => ({ plans: [] })),
    api('/api/verification').catch(() => null),
    api('/api/audit').catch(() => ({ events: [] })),
  ]);
  const planRows = (plans.plans || []).map((plan) => [
    rawCell('<code>' + esc(plan.id) + '</code>'),
    rawCell('<span class="badge ' + (plan.state === 'approved' || plan.state === 'applied-partial' ? 'warn' : plan.state === 'invalid' ? 'bad' : '') + '">' + esc(plan.state) + '</span>'),
    plan.operation,
    plan.target,
    age(plan.ageSeconds),
  ]);
  const events = audit.events || audit.result || [];
  host.innerHTML =
    '<section><h2>Repository verification</h2>' +
      (verification
        ? table(['State', 'Policy', 'Blocking', 'Reason', 'Next'], [[
            rawCell('<span class="badge ' + (verification.state === 'passed' ? 'ok' : 'warn') + '">' + esc(verification.state) + '</span>'),
            verification.policy,
            verification.blocking ? 'yes' : 'no',
            verification.reason,
            verification.nextCommand || '',
          ]])
        : '<p class="muted">No verification contract configured.</p>') + '</section>' +
    '<section><h2>Local plans</h2>' +
      (planRows.length ? table(['Plan', 'State', 'Operation', 'Target', 'Age'], planRows)
        : '<p class="muted">No local plans. Create one with <code>oflow plan</code>.</p>') + '</section>' +
    '<section><h2>Audit trail</h2>' +
      (events.length ? table(['When', 'Action', 'Plan', 'State'], events.map((event) => [
        when(event.at), event.action, rawCell('<code>' + esc(event.planId) + '</code>'), event.state,
      ])) : '<p class="muted">No audit events yet.</p>') + '</section>';
}

function renderTour(host) {
  const steps = [
    ['Start with context', 'Run <code>oflow start --json</code>. One compact record of your story, acceptance criteria, and the commands that are safe right now.'],
    ['Plan before you write', 'Remote changes go through <code>oflow plan</code>, <code>oflow approve</code>, <code>oflow apply</code>, <code>oflow verify</code>. oflow never mutates GitLab on its own.'],
    ['Check the cache is fresh', 'Planning data is cached locally. <code>oflow sync --refresh</code> refreshes it; this dashboard only reads what is already cached.'],
    ['Prove it before finishing', 'Add repository checks under <code>workflow.verification</code>, run <code>oflow verify-local</code>, and <code>oflow finish</code> refuses to close a story on stale evidence.'],
  ];
  host.innerHTML = '<section><h2>The workflow</h2>' +
    steps.map(([title, body]) =>
      '<div class="tour-step"><h3>' + esc(title) + '</h3><p>' + body + '</p></div>').join('') +
    '</section><section><h2>Next</h2><div class="grid">' +
    '<button class="action" data-goto="capabilities" type="button">See capabilities</button>' +
    '<button class="action" data-goto="lifecycle" type="button">See lifecycle</button>' +
    '<button class="action" data-goto="auth" type="button">Connect a token</button>' +
    '</div></section>';
  for (const button of host.querySelectorAll('[data-goto]')) {
    button.addEventListener('click', () => { location.hash = button.dataset.goto; });
  }
}

const RENDERERS = {
  overview: renderOverview,
  capabilities: renderCapabilities,
  auth: renderAuth,
  diagnostics: renderDiagnostics,
  lifecycle: renderLifecycle,
  tour: renderTour,
};

async function show(id) {
  const view = VIEWS.find((entry) => entry.id === id) || VIEWS[0];
  activeView = view.id;
  document.getElementById('view-title').textContent = view.title;
  document.getElementById('subtitle').textContent = view.subtitle;
  document.getElementById('view-actions').innerHTML = '';
  banner('');
  notice('');
  renderTabs();
  const host = document.getElementById('view');
  try {
    await RENDERERS[view.id](host);
  } catch (error) {
    host.innerHTML = '';
    banner('Could not load this view: ' + esc(error.message));
  }
}

window.addEventListener('hashchange', () => { void show(location.hash.slice(1) || 'overview'); });
void show(location.hash.slice(1) || 'overview');
</script>
</body>
</html>
`;
}
