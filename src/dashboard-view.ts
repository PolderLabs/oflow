import { dashboardWorkspaceCss, dashboardWorkspaceScript } from "./dashboard-workspace.js";
import { dashboardInsightsCss, dashboardInsightsScript } from "./dashboard-insights.js";
import { dashboardControlsCss, dashboardControlsScript } from "./dashboard-controls.js";
import { dashboardMapCss, dashboardMapScript } from "./dashboard-map.js";

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
  <title>oflow · Workspace</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; --bg:#f5f6f3; --panel:#fff; --line:#e1e6e1; --text:#20312d; --muted:#596b64; --dim:#61716a; --accent:#087f6d; --ok:#08734b; --warn:#946015; --bad:#b43d3d; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--text); font-size:14px; } button,input,select { font:inherit; } button,a,input,select,summary { -webkit-tap-highlight-color:transparent; }
    .shell { display:grid; grid-template-columns:230px minmax(0,1fr); min-height:100vh; }
    nav { padding:34px 18px; background:#162d29; color:#e8f3ed; position:sticky; top:0; height:100vh; overflow:auto; display:flex; flex-direction:column; }
    nav .brand { font-size:29px; font-weight:750; letter-spacing:-1.5px; padding:0 16px; } .brand::before { content:'◈'; color:#7fe0bd; margin-right:9px; }
    nav .tag { margin:5px 0 34px 17px; font-size:11px; text-transform:uppercase; letter-spacing:2px; color:#a5beb4; }
    nav a { display:flex; align-items:center; gap:12px; color:#becfc6; padding:12px 15px; border-radius:8px; margin:3px 0; text-decoration:none; font-weight:550; } nav a:hover { background:#24413a; text-decoration:none; color:white; } nav a[aria-current="page"] { background:#304f43; color:#ceffde; } .nav-icon { width:20px; text-align:center; font-size:17px; }
    .nav-footer { margin-top:auto; padding:30px 15px 0; font-size:12px; color:#aec7ba; line-height:1.7; } .nav-footer strong { color:#e1f0e7; display:block; }
    main { padding:32px 42px 60px; min-width:0; max-width:1600px; width:100%; margin:auto; } header { display:flex; justify-content:space-between; align-items:center; gap:18px; margin-bottom:20px; flex-wrap:wrap; } .eyebrow { font-size:11px; letter-spacing:1.8px; text-transform:uppercase; color:var(--accent); font-weight:700; margin-bottom:9px; }
    h1 { font-size:32px; letter-spacing:-1.2px; margin:0; font-weight:650; } h2 { font-size:16px; letter-spacing:-.3px; margin:0 0 16px; font-weight:650; } h3 { font-size:14px; margin:0 0 6px; } p { line-height:1.65; color:var(--muted); } header p { margin:8px 0 0; max-width:70ch; font-size:13px; }
    button { cursor:pointer; } .action,.copy { display:inline-flex; align-items:center; justify-content:center; border:1px solid var(--line); border-radius:7px; background:white; color:var(--text); padding:9px 13px; font-weight:550; gap:6px; text-decoration:none; } .action:hover,.copy:hover { background:#eaf3ee; border-color:#afcabc; } .action.primary { background:var(--accent); color:white; border-color:var(--accent); } button:disabled { opacity:.55; cursor:progress; } :focus-visible { outline:3px solid #44b697; outline-offset:3px; } .skip-link { position:fixed; top:-60px; left:16px; z-index:10; background:white; padding:12px; } .skip-link:focus { top:8px; }
    #view-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; } .split { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(0,1fr); gap:18px; } .card,section { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:23px; } section { margin-top:18px; min-width:0; } .card { display:flex; flex-direction:column; gap:8px; } .metric { font-size:30px; font-weight:650; letter-spacing:-1px; font-variant-numeric:tabular-nums; } .card-label { font-size:12px; color:var(--muted); font-weight:600; } .card-note { font-size:11px; color:var(--dim); } .card-note.gap { color:var(--warn); }
    .snapshot { display:flex; flex-wrap:wrap; justify-content:space-between; gap:14px; padding:17px 20px; border:1px solid #cdded1; border-radius:10px; background:#edf3ed; margin-bottom:20px; font-size:12px; line-height:1.8; } .snapshot strong { color:#27624c; } .snapshot code { font-size:11px; } .hero { padding:26px; background:#e9f1e8; border-color:#d8e4d6; margin:0 0 20px; } .hero h2 { font-size:22px; letter-spacing:-.7px; margin-bottom:8px; } .hero p { margin:0; max-width:75ch; } .section-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:16px; } .section-head h2 { margin:0; } .attention { padding:13px 0; display:flex; justify-content:space-between; gap:18px; border-bottom:1px solid var(--line); line-height:1.65; } .attention:last-child { border:0; } .attention p { margin:3px 0 0; font-size:12px; } .attention a { white-space:nowrap; align-self:center; } .command { display:flex; justify-content:space-between; gap:12px; align-items:center; padding:12px; background:#f5f7f3; border-radius:8px; margin-top:10px; } .command code { overflow-wrap:anywhere; font-size:12px; } .copy { padding:6px 9px; font-size:11px; flex-shrink:0; }
    .handoff-label { display:flex; flex-direction:column; gap:8px; font-size:12px; font-weight:600; } .handoff-label select { width:100%; min-width:0; } .handoff-step { padding:18px 0; border-bottom:1px solid var(--line); } .handoff-step h3 { display:flex; align-items:center; gap:9px; } .handoff-step h3 span { display:inline-flex; align-items:center; justify-content:center; width:25px; height:25px; border-radius:50%; background:#e3f4e9; color:var(--accent); font-size:12px; flex-shrink:0; } .handoff-step p { margin:8px 0; } .handoff-boundary { font-size:11px; } .handoff-tools { margin-top:18px; padding-top:14px; border-top:1px solid var(--line); }
    .muted { color:var(--dim); font-size:12px; } .badge { display:inline-block; padding:3px 8px; border-radius:5px; font-size:11px; font-weight:550; color:var(--muted); background:#f1f4ef; margin:2px 4px 2px 0; } .badge.ok,.badge.live { color:#086342; background:#e3f4e9; } .badge.warn { color:#865308; background:#fcf2d9; } .badge.bad { color:#a73333; background:#fcebea; }
    .table-wrap { overflow:auto; max-height:560px; scrollbar-width:thin; } table { border-collapse:separate; border-spacing:0; width:100%; } th,td { text-align:left; padding:13px 12px; vertical-align:top; } th { position:sticky; top:0; z-index:1; background:#f7f9f5; font-size:10px; text-transform:uppercase; letter-spacing:1px; color:var(--dim); font-weight:600; border-bottom:1px solid var(--line); } td { font-size:12px; border-bottom:1px solid #edf0eb; line-height:1.6; } tr:last-child td { border-bottom:0; } tbody tr:hover { background:#f8faf7; } td:first-child { min-width:140px; } a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; } code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; } pre { padding:15px; border-radius:8px; background:#eef3ed; overflow:auto; font-size:12px; line-height:1.7; } details { margin:6px 0; } summary { cursor:pointer; color:var(--accent); } .gap-list { padding-left:19px; font-size:12px; color:var(--muted); line-height:1.8; } .gap-list li { margin-bottom:7px; overflow-wrap:anywhere; } .gap-source { font-weight:600; } .gap-status { color:var(--warn); } .gap-list code { display:block; white-space:pre-wrap; overflow-wrap:anywhere; }
    .toolbar { display:flex; gap:14px; flex-wrap:wrap; align-items:end; margin-bottom:18px; } .toolbar label { display:flex; flex-direction:column; gap:7px; font-size:11px; font-weight:600; } .toolbar label:first-child { flex:1; min-width:190px; } input,select { border:1px solid #c9d4cb; background:white; color:var(--text); border-radius:7px; padding:10px 12px; min-height:39px; } .empty { padding:30px 10px; text-align:center; } .empty p { margin:7px 0 14px; } .hidden { display:none; } #notice:empty { display:none; } #notice { color:var(--accent); padding:0 0 14px; font-size:13px; } #banner { border:1px solid #f0c3be; color:var(--bad); background:#fff0ec; padding:14px; border-radius:8px; margin-bottom:16px; } .loading { color:var(--dim); padding:32px; border:1px dashed #cbd6ca; border-radius:12px; } .tour-step { padding:12px 0 12px 17px; border-left:3px solid #9ad2b7; margin-bottom:16px; } .tour-step p { margin:0; }
    @media(min-width:1500px) { main { padding:40px 55px 70px; } } @media(max-width:1100px) { main { padding:28px 24px; } .shell { grid-template-columns:200px minmax(0,1fr); } .split { grid-template-columns:1fr; } } @media(max-width:760px) { .shell { grid-template-columns:1fr; } nav { height:auto; position:static; padding:18px; } nav .brand { padding:0; font-size:24px; } nav .tag,.nav-footer { display:none; } #tabs { display:flex; overflow:auto; margin-top:14px; gap:4px; } nav a { white-space:nowrap; padding:9px 12px; font-size:12px; } .nav-icon { display:none; } main { padding:24px 16px 45px; } h1 { font-size:27px; } section,.card { padding:18px; } .grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .attention { flex-wrap:wrap; } .toolbar label { flex:1; } }
    @media(prefers-reduced-motion:reduce) { * { scroll-behavior:auto !important; } }
    ${dashboardMapCss}
    ${dashboardWorkspaceCss}
    ${dashboardInsightsCss}
    ${dashboardControlsCss}
  </style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="shell">
  <nav aria-label="Dashboard views">
    <div class="brand">oflow</div>
    <div class="tag">Your workflow, in focus</div>
    <div id="tabs"></div>
    <div class="nav-footer"><strong>● Local workspace</strong>SQLite snapshots · Loopback only<br>No remote writes from this page.</div>
  </nav>
  <main id="main" tabindex="-1">
    <header>
      <div>
        <div class="eyebrow">Workspace / oflow</div>
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
const safeUrl = (url) => typeof url === 'string' && /^https?:\\/\\//i.test(url) && !/[\\u0000-\\u0020\\u007f]/.test(url);
const link = (title, url) => safeUrl(url) ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '</a>' : esc(title);
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
  { id: 'activity', label: 'Activity', title: 'Evidence & activity', subtitle: 'Local actions and recorded observations—not a live GitLab event stream.' },
  { id: 'work', label: 'Work', title: 'Your work, in focus', subtitle: 'Find a story, inspect its planning context, and hand it to your agent.' },
  { id: 'delivery', label: 'Delivery', title: 'Delivery pulse', subtitle: 'Merge requests and pipeline evidence from the cached snapshot. Not live CI status.' },
  { id: 'planning', label: 'Planning', title: 'Make room for what’s next', subtitle: 'Timeboxes, boards, and labels from your last sync.' },
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

/* A snapshot's warnings mix scope gaps with advisory notes. Only the former
 * means "this token cannot read this source"; the latter (type coverage, a
 * drifted remote, a snapshot from another branch) must never be presented as
 * a readability failure. */
const unreadablePrefix = 'Could not read ';
const isUnreadableSource = (warning) => new RegExp('^' + unreadablePrefix, 'i').test(String(warning ?? ''));
function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.replaceChildren();
  const icons = { overview:'◈', activity:'↻', work:'▤', delivery:'↗', planning:'▦', capabilities:'◇', auth:'⌘', diagnostics:'⌁', lifecycle:'↻', tour:'?' };
  for (const view of VIEWS) {
    const anchor = document.createElement('a');
    anchor.href = '#' + view.id;
    anchor.innerHTML = '<span class="nav-icon" aria-hidden="true">' + icons[view.id] + '</span>' + esc(view.label);
    if (view.id === activeView) anchor.setAttribute('aria-current', 'page');
    tabs.append(anchor);
  }
}

let activeView = 'overview';

${dashboardMapScript}
${dashboardWorkspaceScript}
${dashboardInsightsScript}
${dashboardControlsScript}

async function renderOverview(host) {
  const data = await api('/api/data');
  const status = data.status || {};
  const counts = status.counts || {};
  const project = data.project;
  // A source the token could not read yields an empty list, which is
  // indistinguishable from "none exist". Say so rather than let the cockpit
  // claim the project has no pipelines.
  //
  // Only scope gaps belong here. A snapshot's warnings also cover advisory
  // notes that have nothing to do with readability -- type coverage, a drifted
  // git remote, a snapshot taken on another branch -- and labelling those
  // "cannot read" would be a different falsehood.
  const allWarnings = Array.isArray(data.warnings) ? data.warnings : [];
  const unreadable = allWarnings.filter(isUnreadableSource);
  const advisories = allWarnings.filter((w) => !isUnreadableSource(w));

  // Attribute a caption to the card that owns the unreadable source. A
  // pipelines-only gap must not annotate the Merge requests count, or a
  // readable zero would look like an unreadable one.
  const gapFor = (...names) => (unreadable.some((w) => {
    const source = String(w).slice(unreadablePrefix.length).split(':')[0].trim().toLowerCase();
    return names.includes(source);
  }) ? 'not readable with this token' : undefined);
  const sourceGap = unreadable.length
    ? '<section><h2>Data sources this token cannot read</h2>' +
      '<p class="muted">Counts above are not evidence of absence for these:</p><ul class="gap-list">' +
      unreadable.map((w) => {
        // GitLabApiError embeds the full request path plus a JSON body. Show
        // the source and status; keep the raw text available on demand.
        const source = String(w).slice(unreadablePrefix.length).split(':')[0].trim();
        // Match the real marker "GitLab API 403". A loose three-digit scan can
        // pick a number out of the encoded project path or a JSON body and
        // present it as the status. Note the doubled backslash: this code is
        // inside a template literal, where a single one would be cooked away
        // and leave a regex that matches a literal "d".
        const status = /GitLab API (\\d{3})/.exec(String(w))?.[1];
        const detail = esc(w);
        return '<li><span class="gap-source">' + esc(source) + '</span>' +
          (status ? ' <span class="gap-status">HTTP ' + esc(status) + '</span>' : '') +
          '<details><summary>detail</summary><code>' + detail + '</code></details></li>';
      }).join('') + '</ul></section>'
    : '';
  const advisoryNote = advisories.length
    ? '<section><h2>Sync warnings</h2>' +
      '<p class="muted">Recorded by the last sync. Not an indication of missing data.</p>' +
      '<ul class="gap-list">' + advisories.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></section>'
    : '';

  const metrics = [
    metric('Work items', (data.workItems || []).length, gapFor('work items') || (status.latestSync ? age(status.latestSync.ageSeconds) : 'no snapshot yet'), gapFor('work items') ? 'gap' : ''),
    metric('Merge requests', (data.mergeRequests || []).length, gapFor('merge requests') || 'in cached snapshot', gapFor('merge requests') ? 'gap' : ''),
    metric('Pipelines', (data.pipelines || []).length, gapFor('pipelines') || 'in cached snapshot', gapFor('pipelines') ? 'gap' : ''),
    metric('Iterations', (data.iterations || []).length, gapFor('project iterations', 'iterations'), gapFor('project iterations', 'iterations') ? 'gap' : ''),
  ];
  const open = (data.workItems || []).filter((item) => item.state === 'opened');
  const unassigned = open.filter((item) => !(item.assignees || []).length);
  const failed = (data.pipelines || []).filter((pipeline) => pipeline.status === 'failed');
  const attention = [];
  if (!status.latestSync) attention.push(['Build your first snapshot', 'Run a sync in your terminal to bring GitLab context into this workspace.', 'tour', 'Get started']);
  if (status.invalidation && status.invalidation.at) attention.push(['Snapshot invalidated', status.invalidation.reason || 'Remote changes require a new sync before planning or applying.', 'lifecycle', 'Review lifecycle']);
  if (status.refreshRequest && status.refreshRequest.at) attention.push(['Refresh requested', 'A local request is pending. It does not run a sync automatically.', 'tour', 'See workflow']);
  if (failed.length) attention.push([failed.length + ' failed pipeline' + (failed.length === 1 ? '' : 's'), 'Inspect cached failures, then verify current evidence in GitLab.', 'delivery', 'Review delivery']);
  if (unassigned.length) attention.push([unassigned.length + ' unassigned open item' + (unassigned.length === 1 ? '' : 's'), 'Clarify ownership before the next handoff.', 'work', 'Review work']);
  if (unreadable.length) attention.push([unreadable.length + ' unreadable data source' + (unreadable.length === 1 ? '' : 's'), 'Empty counts do not prove these resources are absent.', 'diagnostics', 'Check access']);
  const planning = data.planning || {};
  host.innerHTML = snapshotStrip(data) +
    '<section id="overview-map" class="work-map" aria-labelledby="map-title"></section>' +
    '<div id="overview-insights"></div>' +
    '<div class="grid">' + metrics.join('') + '</div>' +
    '<div class="split"><section><div class="section-head"><h2>Needs attention</h2><span class="badge">' + attention.length + ' signals</span></div>' +
    (attention.length ? attention.map(([title, detail, view, label]) => '<div class="attention"><div><h3>' + esc(title) + '</h3><p>' + esc(detail) + '</p></div><a href="#' + view + '">' + label + ' →</a></div>').join('') : '<p>No attention signals in this bounded snapshot. Cached evidence is not proof of current remote health.</p>') +
    '</section><section id="agent-handoff" aria-labelledby="handoff-title"></section></div>' +
    sourceGap + advisoryNote +
    '<section><div class="section-head"><h2>Planning at a glance</h2><a href="#planning">Explore planning →</a></div><div class="grid">' +
    metric('Labels', (planning.labels || []).length, gapFor('project labels'), gapFor('project labels') ? 'gap' : '') +
    metric('Milestones', (planning.milestones || []).length, gapFor('project milestones'), gapFor('project milestones') ? 'gap' : '') +
    metric('Boards', (planning.boards || []).length, gapFor('project boards'), gapFor('project boards') ? 'gap' : '') + '</div></section>' +
    '<section><h2>Local read model</h2><div class="grid">' + metric('Snapshots', counts.syncSnapshots ?? 0, 'stored locally; not a project total') + metric('Read model', status.state || 'missing', status.databaseExists ? 'sqlite ready' : 'not created yet') + '</div><h3 style="margin-top:22px">Sync history</h3>' +
    (data.syncHistory && data.syncHistory.length ? table(['Generated', 'Branch', 'Source', 'Warnings'], data.syncHistory.map((entry) => [when(entry.generatedAt), entry.branch || '', entry.source || '', entry.warningCount])) : '<p class="muted">No sync history yet. Run <code>oflow sync --refresh</code>.</p>') + '</section>';
  const mapHost = host.querySelector && host.querySelector('#overview-map');
  if (mapHost) renderWorkMap(mapHost, data);
  const handoffHost = host.querySelector && host.querySelector('#agent-handoff');
  if (handoffHost) renderAgentHandoff(handoffHost, data);
  const insightsHost = host.querySelector && host.querySelector('#overview-insights');
  if (insightsHost) await renderDashboardInsights(insightsHost, data);
}

const command = (value, label) => '<div class="command"><code>' + esc(value) + '</code><button type="button" class="copy" data-copy="' + esc(value) + '" aria-label="Copy command: ' + esc(label || value) + '">Copy</button></div>';
function renderAgentHandoff(host, data) {
  const stories = (data.workItems || []).filter((item) => Number.isSafeInteger(item.iid) && item.iid > 0);
  host.innerHTML = '<div class="eyebrow">Continue with confidence</div><h2 id="handoff-title">Your next agent handoff</h2>' +
    '<p>Choose a story, copy the command for your next step, then run it in your repository terminal. Share its output with your agent—not just the command.</p>' +
    '<label class="handoff-label" for="handoff-story">Story to work on<select id="handoff-story"><option value="">Choose a cached story…</option>' + stories.map((item,index) => '<option value="'+index+'">'+esc('#'+item.iid+' · '+item.title+' ('+(item.state || 'state unknown')+')')+'</option>').join('') + '</select></label>' +
    '<div id="handoff-steps" role="region" aria-label="Story handoff commands" aria-live="polite"></div>' +
    '<details class="handoff-tools"><summary>Need a fresher starting point?</summary>' +
    '<p class="muted">Find your assigned work in GitLab. This fetches work when run in your terminal; it does not select or start a story.</p>'+command('oflow work --mine --refresh --json','Refresh my assigned work')+
    '<p class="muted">Refresh the dashboard snapshot from GitLab, then use Reload local data here.</p>'+command('oflow sync --refresh','Refresh dashboard snapshot')+
    '<p class="muted">Read a compact project summary from the local cache without fetching GitLab data.</p>'+command('oflow sync --summary --cached --json','Read cached project summary')+'</details>';
  const select = host.querySelector('#handoff-story');
  const steps = host.querySelector('#handoff-steps');
  const draw = () => {
    const item = stories.find((_,index) => String(index) === select.value);
    if (!item) { steps.innerHTML = '<p class="muted">'+(stories.length ? 'Choose a story above to get exact commands. No story is selected automatically.' : 'No valid cached stories yet. Refresh the snapshot in your terminal, then reload local data.')+'</p>'; return; }
    const step = (number,title,detail,cmd) => '<div class="handoff-step"><h3><span aria-hidden="true">'+number+'</span>'+title+'</h3><p class="muted">'+detail+'</p>'+command(cmd,title)+'</div>';
    steps.innerHTML = '<p><a class="action primary" href="#story/'+item.iid+'">Open connected story workspace →</a></p><p class="muted">Commands below target <strong>'+esc('#'+item.iid+' '+item.title)+'</strong>. Run only the step you need. These commands may read GitLab; they do not implement or close the story.</p>' +
      step('1','Start or resume work','Use at session start. Gives the agent story context, acceptance criteria, a branch recommendation and execution-backend guidance.','oflow start --story '+item.iid+' --json') +
      step('2','Check what is still missing','Use before calling the work done. Reports acceptance-criteria evidence, local changes, MR/pipeline status and blockers; it does not run your test suite.','oflow assess --story '+item.iid+' --json') +
      step('3','Prepare the next agent’s brief','Use when switching agents or sessions. Produces a compact brief with criteria evidence, branch and changed files, recent commits, MR/pipeline status, blockers and next actions.','oflow handoff --story '+item.iid+' --json') +
      '<p class="handoff-boundary">Copy only · nothing runs in this browser. Review the output for sensitive details before sharing. A handoff is not approval to apply changes.</p>';
  };
  select.addEventListener('change',draw);
  draw();
}
const badge = (value) => '<span class="badge ' + (['success','passed','merged','closed'].includes(value) ? 'ok' : ['failed','invalid'].includes(value) ? 'bad' : ['running','pending','opened'].includes(value) ? 'warn' : '') + '">' + esc(value || 'not recorded') + '</span>';
const empty = (title, detail) => '<div class="empty"><h3>' + esc(title) + '</h3><p class="muted">' + esc(detail || 'No records in this cached scope. Run oflow sync --refresh to update it.') + '</p></div>';
function snapshotStrip(data) {
  const status = data.status || {};
  const query = data.query;
  return '<div class="snapshot"><div><strong>● Cached snapshot · not live</strong><br>' +
    (data.project ? link(data.project.path, data.project.webUrl) + ' · ' : '') + esc(status.latestSync ? 'Synced ' + age(status.latestSync.ageSeconds) : 'no snapshot yet') +
    (data.repository && data.repository.branch ? ' · branch ' + esc(data.repository.branch) : '') + '<br><span>Counts describe the displayed snapshot, not project totals.</span>' +
    (query ? '<br>Scope: ' + esc(query.state) + ' work · limit ' + esc(query.issueLimit) + (query.issueFilters && Object.keys(query.issueFilters).length ? ' · filters ' + esc(JSON.stringify(query.issueFilters)) : '') : '<br>Query scope unavailable') +
    (data.workItemsMayBeTruncated ? '<br><strong>Work items may be truncated.</strong>' : '') +
    (status.invalidation && status.invalidation.at ? '<br><strong>Invalidated — refresh before remote changes.</strong>' : '') +
    (status.refreshRequest && status.refreshRequest.at ? '<br>Refresh requested locally; run the CLI to sync.' : '') +
    '</div><div><button type="button" class="action" data-refresh>Request sync</button><p class="muted">Records a local request only. No GitLab sync.</p></div></div>';
}
function sourceWarnings(data) {
  return (data.warnings || []).length ? '<section><h2>Snapshot coverage</h2><ul class="gap-list">' + data.warnings.map((warning) => '<li><strong>' + (isUnreadableSource(warning) ? 'Unreadable source: ' : 'Advisory: ') + '</strong>' + esc(warning) + '</li>').join('') + '</ul></section>' : '';
}
function workTable(items) {
  return items.length ? table(['Story', 'State', 'Owner', 'Planning / handoff'], items.map((item) => [
    rawCell((Number.isSafeInteger(item.iid) && item.iid > 0 ? '<a href="#story/'+item.iid+'">'+esc('#'+item.iid+' '+item.title)+'</a><br>'+link('Open in GitLab',item.webUrl) : link('#'+item.iid+' '+item.title,item.webUrl))), rawCell(badge(item.state)), (item.assignees || []).join(', ') || 'Unassigned',
    rawCell('<span class="muted">' + esc([item.milestone, item.iteration].filter(Boolean).join(' · ') || 'No timebox') + '</span><details><summary>Story details & commands</summary><p>Labels: ' + esc((item.labels || []).join(', ') || 'None') + '<br>Updated: ' + esc(when(item.updatedAt) || 'Not recorded') +
      '<br>Due: ' + esc(item.dueDate || 'Not set') + '<br>Weight: ' + esc(item.weight ?? 'Not set') + (item.taskCompletion ? '<br>Tasks: ' + esc(item.taskCompletion.completed) + ' / ' + esc(item.taskCompletion.total) : '') + '</p>' +
      (Number.isSafeInteger(item.iid) && item.iid > 0 ? command('oflow context --story ' + item.iid + ' --json', 'Story context') + command('oflow assess --story ' + item.iid + ' --json', 'Assess story') : '') + '</details>'),
  ])) : empty('No matching work items', 'Try another filter, or refresh the cached scope from your terminal.');
}
function filterWork(items, search, state, ownership) {
  const needle = search.trim().toLowerCase();
  return items.filter((item) => (state === 'all' || item.state === state) && (ownership === 'all' || (ownership === 'unassigned' ? !(item.assignees || []).length : (item.assignees || []).length > 0)) &&
    [item.iid, item.title, ...(item.labels || []), ...(item.assignees || []), item.milestone, item.iteration].join(' ').toLowerCase().includes(needle));
}
async function renderWork(host) {
  const data = await api('/api/data');
  const items = data.workItems || [];
  host.innerHTML = snapshotStrip(data) + '<section><h2>Work queue</h2><div class="toolbar"><label for="work-search">Search stories, labels, or owners<input id="work-search" type="search" placeholder="Find your next story…" autocomplete="off"></label><label for="work-state">State<select id="work-state"><option value="all">All states</option><option value="opened">Open</option><option value="closed">Closed</option></select></label><label for="work-owner">Ownership<select id="work-owner"><option value="all">All owners</option><option value="assigned">Assigned</option><option value="unassigned">Unassigned</option></select></label></div><p id="work-count" class="muted" role="status"></p><div id="work-results"></div></section>' + sourceWarnings(data);
  const search = host.querySelector('#work-search');
  const state = host.querySelector('#work-state');
  const owner = host.querySelector('#work-owner');
  const update = () => {
    const matches = filterWork(items, search.value, state.value, owner.value);
    host.querySelector('#work-count').textContent = matches.length + ' of ' + items.length + ' cached items';
    host.querySelector('#work-results').innerHTML = workTable(matches);
  };
  search.addEventListener('input', update); state.addEventListener('change', update); owner.addEventListener('change', update); update();
}
async function renderDelivery(host) {
  const data = await api('/api/data');
  const mrs = data.mergeRequests || []; const pipelines = data.pipelines || [];
  host.innerHTML = snapshotStrip(data) + '<div class="grid">' + metric('Open merge requests', mrs.filter((mr) => mr.state === 'opened').length, 'in snapshot') + metric('Failed pipelines', pipelines.filter((p) => p.status === 'failed').length, 'in snapshot; not latest per branch') + metric('Running pipelines', pipelines.filter((p) => p.status === 'running').length, 'cached status') + '</div><section><h2>Merge requests</h2>' +
    (mrs.length ? table(['Merge request', 'State', 'Branches', 'Updated'], mrs.map((mr) => [rawCell(link('!' + mr.iid + ' ' + mr.title, mr.webUrl) + (mr.draft ? ' <span class="badge">Draft</span>' : '')), rawCell(badge(mr.state)), (mr.sourceBranch || '—') + ' → ' + (mr.targetBranch || '—'), when(mr.updatedAt)])) : empty('No cached merge requests')) + '</section><section><h2>Pipeline evidence</h2><p class="muted">A successful cached pipeline does not prove the current head is verified. Use story assessment before finishing.</p>' +
    (pipelines.length ? table(['Pipeline', 'Status', 'Ref', 'Commit', 'Updated'], pipelines.map((p) => [rawCell(link('#' + p.id, p.webUrl)), rawCell(badge(p.status)), p.ref || '—', rawCell('<code>' + esc((p.sha || '').slice(0, 12)) + '</code>'), when(p.updatedAt)])) : empty('No cached pipelines')) + '</section>' + sourceWarnings(data);
}
async function renderPlanning(host) {
  const data = await api('/api/data'); const planning = data.planning || {};
  const timeboxes = (items) => items.length ? table(['Timebox', 'State', 'Starts', 'Due'], items.map((item) => [rawCell(link(item.title || 'Iteration #' + item.iid, item.webUrl)), item.state || 'Not recorded', item.startDate || 'Not set', item.dueDate || 'Not set'])) : empty('No timeboxes in this snapshot');
  host.innerHTML = snapshotStrip(data) + '<div class="split"><section><h2>Iterations</h2>' + timeboxes(data.iterations || []) + '</section><section><h2>Milestones</h2>' + timeboxes(planning.milestones || []) + '</section></div><section><h2>Boards & lists</h2>' +
    ((planning.boards || []).length ? table(['Board', 'Lists'], planning.boards.map((board) => [board.name, rawCell((board.lists || []).map((list) => '<span class="badge">' + esc(list.label || 'List #' + list.id) + '</span>').join('') || '<span class="muted">No cached lists</span>')])) : empty('No cached boards')) + '</section><section><h2>Label vocabulary</h2>' +
    ((planning.labels || []).length ? table(['Label', 'Open issues', 'Closed issues', 'Open MRs'], planning.labels.map((label) => [rawCell('<span class="badge">' + esc(label.name) + '</span>'), label.openIssues ?? 'Not recorded', label.closedIssues ?? 'Not recorded', label.openMergeRequests ?? 'Not recorded'])) : empty('No cached labels')) + '</section>' +
    (data.planningHealth && data.planningHealth.findings.length ? '<section><h2>Planning findings</h2>' + table(['Finding', 'Stories'], data.planningHealth.findings.map((finding) => [finding.message, finding.storyIids.map((iid) => '#' + iid).join(', ')])) + '</section>' : '') + sourceWarnings(data);
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
  host.actions.innerHTML =
    '<button class="action" id="probe" type="button">Run capability probe</button>';
  host.actions.querySelector('#probe').addEventListener('click', runProbe);
}

async function runProbe(event) {
  const generation = renderGeneration;
  const button = event.currentTarget;
  busy(button, true, 'Run capability probe');
  banner('');
  try {
    const report = await api('/api/check-api', { method: 'POST' });
    if (generation !== renderGeneration) return;
    const checks = report.apiChecks || [];
    const failed = checks.filter((check) => check.status === 'failed');
    notice(failed.length
      ? failed.length + ' of ' + checks.length + ' capability checks failed.'
      : checks.filter((check) => check.status === 'passed').length + ' passed · ' + checks.filter((check) => check.status === 'skipped').length + ' skipped · ' + checks.filter((check) => check.status === 'not-probed').length + ' not probed.');
  } catch (error) {
    if (generation === renderGeneration) banner('Capability probe failed: ' + error.message);
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
  host.actions.innerHTML =
    '<button class="action" id="recheck" type="button">Re-check status</button>';
  host.actions.querySelector('#recheck').addEventListener('click', () => { void show(activeView); });
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
  const generation = renderGeneration;
  busy(button, true, 'Run API check');
  banner('');
  try {
    const report = await api('/api/check-api', { method: 'POST' });
    if (generation !== renderGeneration) return;
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
    const retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'action'; retry.textContent = 'Run API check again';
    retry.addEventListener('click', () => { void runDiagnostics(host, retry); }); host.append(retry);
    notice('API check complete: ' + report.apiCheck + '.');
  } catch (error) {
    if (generation === renderGeneration) banner('API check failed: ' + error.message);
  } finally {
    busy(button, false, 'Run API check');
  }
}

async function renderLifecycle(host) {
  const [plans, verification, audit] = await Promise.all([
    api('/api/plans'), api('/api/verification'), api('/api/audit'),
  ]);
  const planRows = (plans.plans || []).map((plan) => [
    rawCell('<code>' + esc(plan.id) + '</code><br><button type="button" class="action" data-preview-plan="'+esc(plan.id)+'">Preview saved plan</button>'),
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
    '<section><h2>Local plans</h2><p class="muted">Preview only. Approval, application and verification remain explicit CLI operations.</p><div id="plan-preview" role="region" aria-label="Saved plan preview" aria-live="polite"></div>' +
      (planRows.length ? table(['Plan', 'State', 'Operation', 'Target', 'Age'], planRows)
        : '<p class="muted">No local plans. Create one with <code>oflow plan</code>.</p>') + '</section>' +
    '<section><h2>Audit trail</h2>' +
      (events.length ? table(['When', 'Action', 'Plan', 'State'], events.map((event) => [
        when(event.at), event.action, rawCell('<code>' + esc(event.planId) + '</code>'), event.state,
      ])) : '<p class="muted">No audit events yet.</p>') + '</section>';
  host.querySelectorAll('[data-preview-plan]').forEach((button)=>button.addEventListener('click',async()=>{
    const preview=host.querySelector('#plan-preview');button.disabled=true;
    try {const result=await api('/api/plans/'+encodeURIComponent(button.dataset.previewPlan));preview.innerHTML='<h3>Saved plan '+esc(result.id)+'</h3><pre>'+esc(result.preview)+'</pre><p class="muted">This preview does not grant approval or verify remote state.</p>';}
    catch(error){preview.textContent='Preview unavailable: '+error.message;}
    finally{button.disabled=false;}
  }));
}

function renderTour(host) {
  const steps = [
    ['Start with context', 'Run <code>oflow start --json</code>. One compact record of your story, acceptance criteria, and the commands that are safe right now.'],
    ['Plan before you write', 'Remote changes go through <code>oflow plan</code>, <code>oflow approve</code>, <code>oflow apply</code>, <code>oflow verify</code>. oflow never mutates GitLab on its own.'],
    ['Check the cache is fresh', 'Planning data is cached locally. <code>oflow sync --refresh</code> refreshes it; navigation reads the cache; explicit actions in Activity can refresh it.'],
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

async function renderActivity(host) {
  const data = await api('/api/data');
  host.innerHTML = '<div id="activity-actions"></div><div id="activity-insights"></div>';
  const controls = host.querySelector('#activity-actions');
  host.dispose = () => { if(controls.dispose) controls.dispose(); };
  await Promise.all([renderActionConsole(controls),renderDashboardInsights(host.querySelector('#activity-insights'),data)]);
}

const RENDERERS = {
  activity: renderActivity,
  overview: renderOverview,
  work: renderWork,
  delivery: renderDelivery,
  planning: renderPlanning,
  capabilities: renderCapabilities,
  auth: renderAuth,
  diagnostics: renderDiagnostics,
  lifecycle: renderLifecycle,
  tour: renderTour,
};

let renderGeneration = 0;
let disposeView = null;
function bindInteractions(host) {
  host.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy], [data-refresh]');
    if (!button || !host.contains(button)) return;
    const generation = renderGeneration;
    const label = button.textContent;
    busy(button, true, label);
    try {
      if (button.hasAttribute('data-copy')) {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable. Select and copy the visible command instead.');
        await navigator.clipboard.writeText(button.dataset.copy);
        if (generation === renderGeneration) notice(button.dataset.copyKind === 'brief' ? 'Agent brief copied. Review it before sharing with your agent.' : 'Command copied. Run it in your repository terminal.');
      } else {
        const result = await api('/api/refresh', { method: 'POST' });
        if (generation === renderGeneration) {
          notice(result.message || 'Refresh requested locally. Run oflow sync --refresh in your terminal.');
          button.textContent = result.accepted ? 'Refresh requested' : 'Run a sync first';
        }
      }
    } catch (error) {
      if (generation === renderGeneration) banner(error.message);
    } finally {
      button.disabled = false;
      if (button.hasAttribute('data-copy') || button.textContent === 'Working…') button.textContent = label;
    }
  });
}
async function show(id) {
  const generation = ++renderGeneration;
  if(disposeView) {disposeView();disposeView=null;}
  const storyMatch = /^story\\/([1-9][0-9]*)$/.exec(id);
  const storyIid = storyMatch && Number.isSafeInteger(Number(storyMatch[1])) ? Number(storyMatch[1]) : null;
  const view = VIEWS.find((entry) => entry.id === id) || VIEWS[0];
  activeView = storyIid ? 'work' : view.id;
  document.getElementById('view-title').textContent = storyIid ? 'Story #'+storyIid : view.title;
  document.getElementById('subtitle').textContent = storyIid ? 'Connected context, evidence and agent handoff. GitLab reads run only when requested.' : view.subtitle;
  const actions = document.getElementById('view-actions');
  actions.innerHTML = '';
  const reload = document.createElement('button');
  reload.type = 'button'; reload.className = 'action'; reload.textContent = 'Reload local data';
  reload.addEventListener('click', () => { void show(storyIid ? 'story/'+storyIid : view.id); });
  banner(''); notice(''); renderTabs();
  const container = document.getElementById('view');
  container.setAttribute('aria-busy', 'true');
  container.innerHTML = '<div class="loading" role="status">Loading local workspace…</div>';
  // Each request owns a detached host and toolbar. An older response cannot
  // replace the current view or install actions after the user navigates away.
  const host = document.createElement('div');
  host.actions = document.createElement('div');
  try {
    if(storyIid) await renderStoryWorkspace(host,storyIid); else await RENDERERS[view.id](host);
    if (generation !== renderGeneration) {if(host.dispose) host.dispose();return;}
    disposeView = () => {if(host.dispose) host.dispose();};
    bindInteractions(host);
    container.replaceChildren(host);
    actions.replaceChildren(reload, host.actions);
  } catch (error) {
    if(host.dispose) host.dispose();
    if (generation !== renderGeneration) return;
    container.innerHTML = '<div class="empty"><h3>This view is unavailable</h3><p>No empty-data assumptions were made. Check local setup and retry.</p><button type="button" class="action" id="retry-view">Try again</button></div>';
    container.querySelector('#retry-view').addEventListener('click', () => { void show(storyIid ? 'story/'+storyIid : view.id); });
    banner('Could not load this view: ' + error.message);
  } finally {
    if (generation === renderGeneration) container.setAttribute('aria-busy', 'false');
  }
}

window.addEventListener('hashchange', () => { if (location.hash !== '#main') void show(location.hash.slice(1) || 'overview'); });
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  const main = document.getElementById('main');
  main.focus(); main.scrollIntoView();
});
void show(location.hash.slice(1) || 'overview');
</script>
</body>
</html>
`;
}
