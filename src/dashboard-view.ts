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
      --bg: #111318; --panel: rgba(21,25,35,.86); --line: #2d3545;
      --text: #e8eaf0; --muted: #aeb8cc; --dim: #8994aa;
      --accent: #6ea8fe; --ok: #57d9a3; --warn: #f2c14e; --bad: #f2777a;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at top right, #253047, #111318 42%); min-height: 100vh; color: var(--text); }
    .shell { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }
    nav { border-right: 1px solid var(--line); padding: 22px 14px; background: rgba(16,19,26,.6); }
    nav .brand { font-size: 1.35rem; font-weight: 700; letter-spacing: -.03em; margin-bottom: 4px; }
    nav .tag { color: var(--dim); font-size: .78rem; margin-bottom: 18px; }
    nav button {
      display: block; width: 100%; text-align: left; background: none; border: 1px solid transparent;
      color: var(--muted); padding: 9px 11px; border-radius: 9px; cursor: pointer; font-size: .93rem; margin-bottom: 3px;
    }
    nav button:hover { background: rgba(255,255,255,.05); color: var(--text); }
    nav button[aria-selected="true"] { background: #25314a; border-color: #3c4c6d; color: #fff; }
    main { padding: 26px 24px 60px; max-width: 1180px; }
    header { display: flex; justify-content: space-between; gap: 18px; align-items: end; margin-bottom: 20px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: clamp(1.5rem, 3vw, 2.2rem); letter-spacing: -.035em; }
    h2 { margin: 0 0 12px; font-size: .78rem; color: var(--muted); text-transform: uppercase; letter-spacing: .09em; }
    p { color: var(--muted); line-height: 1.55; }
    button.action { cursor: pointer; border: 1px solid #4a5b80; border-radius: 999px; padding: 8px 14px; color: #eef3ff; background: #25314a; font-size: .9rem; }
    button.action:hover:not(:disabled) { background: #31405e; }
    button.action:disabled { opacity: .5; cursor: progress; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .card, section { border: 1px solid var(--line); background: var(--panel); border-radius: 14px; padding: 16px; }
    section { margin-top: 14px; }
    .metric { font-size: 1.9rem; font-weight: 700; }
    .muted { color: var(--dim); font-size: .86rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: .72rem; border: 1px solid var(--line); color: var(--muted); margin-right: 5px; }
    .badge.ok { color: var(--ok); border-color: #2c5c48; background: rgba(87,217,163,.09); }
    .badge.warn { color: var(--warn); border-color: #5d4c22; background: rgba(242,193,78,.09); }
    .badge.bad { color: var(--bad); border-color: #6b3437; background: rgba(242,119,122,.09); }
    .badge.live { color: var(--accent); border-color: #35507d; background: rgba(110,168,254,.1); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: #9eabc1; font-size: .74rem; text-transform: uppercase; letter-spacing: .07em; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre { background: #0d1017; border: 1px solid var(--line); border-radius: 9px; padding: 11px 13px; overflow-x: auto; color: #cfe0ff; font-size: .85rem; }
    .hidden { display: none; }
    #notice { min-height: 1.4em; margin-bottom: 10px; color: var(--accent); font-size: .9rem; }
    #banner { margin-bottom: 14px; border-radius: 10px; padding: 10px 13px; font-size: .9rem; }
    #banner.bad { color: var(--bad); background: rgba(242,119,122,.1); border: 1px solid #6b3437; }
    .tour-step { border-left: 3px solid var(--accent); padding-left: 13px; margin-bottom: 14px; }
    .tour-step h3 { margin: 0 0 4px; font-size: 1rem; }
    @media (max-width: 760px) {
      .shell { grid-template-columns: 1fr; }
      nav { border-right: none; border-bottom: 1px solid var(--line); }
      nav button { display: inline-block; width: auto; }
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
const rawCell = (html) => ({ __html: html });
const cell = (value) => (value !== null && typeof value === 'object' && value.__html !== undefined
  ? value.__html
  : esc(value));
const table = (headers, rows) =>
  '<table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') +
  '</tr></thead><tbody>' + rows.map((cells) =>
    '<tr>' + cells.map((entry) => '<td>' + cell(entry) + '</td>').join('') + '</tr>').join('') +
  '</tbody></table>';

const metric = (label, value, note) =>
  '<div class="card"><div class="metric">' + esc(value) + '</div><div>' + esc(label) + '</div>' +
  (note ? '<div class="muted">' + esc(note) + '</div>' : '') + '</div>';

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
  const metrics = [
    metric('Work items', counts.workItems ?? 0,
      status.latestSync ? age(status.latestSync.ageSeconds) : 'no snapshot yet'),
    metric('Merge requests', counts.mergeRequests ?? 0),
    metric('Pipelines', counts.pipelines ?? 0),
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
    item.updatedAt || '',
  ]);
  const mrRows = (data.mergeRequests || []).map((mr) => [
    rawCell(link('!' + mr.iid + ' ' + (mr.title || ''), mr.webUrl)),
    mr.state,
    mr.sourceBranch || '',
    mr.updatedAt || '',
  ]);
  const planning = data.planning || {};
  host.innerHTML =
    (project ? '<section><h2>Project</h2><p>' + esc(project.host) + ' / ' + esc(project.path) +
      (data.repository && data.repository.branch ? ' · ' + esc(data.repository.branch) : '') + '</p></section>' : '') +
    '<div class="grid">' + metrics.join('') + '</div>' +
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
            entry.generatedAt, entry.branch || '', entry.source || '', entry.warningCount,
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
        event.at, event.action, rawCell('<code>' + esc(event.planId) + '</code>'), event.state,
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
