import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { OflowError } from "./errors.js";
import {
  readDashboardData,
  readReadModelStatus,
  requestReadModelRefresh,
} from "./read-model.js";

export interface DashboardOptions {
  port?: number;
}

export interface DashboardServer {
  url: string;
  close(): Promise<void>;
}

export async function startDashboard(
  root: string,
  options: DashboardOptions = {},
): Promise<DashboardServer> {
  const port = options.port ?? 4173;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new OflowError("Dashboard port must be an integer between 0 and 65535.", "INVALID_DASHBOARD_PORT");
  }
  const server = createServer((request, response) => {
    void handleRequest(root, request, response);
  });
  await listen(server, port);
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  return {
    url: "http://127.0.0.1:" + String(actualPort) + "/",
    close: () => closeServer(server),
  };
}

async function handleRequest(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");

    if (request.method === "GET" && url.pathname === "/") {
      writeText(response, 200, dashboardHtml());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      writeJson(response, 200, await readReadModelStatus(root));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/data") {
      writeJson(response, 200, await readDashboardData(root));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      const accepted = await requestReadModelRefresh(root);
      writeJson(response, 202, {
        accepted,
        remoteRefreshRequired: accepted,
        command: accepted ? "oflow sync --refresh" : null,
        credentialsExposed: false,
        message: accepted
          ? "Refresh requested locally. Run the CLI command to contact GitLab; the dashboard never receives credentials."
          : "No local read model exists yet. Run oflow sync --refresh first.",
      });
      return;
    }
    writeJson(response, 404, { error: "Not found" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(response, 500, { error: message });
  }
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>oflow local planning dashboard</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #111318; color: #e8eaf0; }
    body { margin: 0; background: radial-gradient(circle at top right, #253047, #111318 42%); min-height: 100vh; }
    main { max-width: 1180px; margin: 0 auto; padding: 36px 22px 64px; }
    header { display: flex; justify-content: space-between; gap: 18px; align-items: end; margin-bottom: 26px; }
    h1 { margin: 0; font-size: clamp(1.8rem, 4vw, 3rem); letter-spacing: -0.04em; }
    h2 { margin: 0 0 12px; font-size: 1rem; color: #aeb8cc; text-transform: uppercase; letter-spacing: .08em; }
    p { color: #aeb8cc; line-height: 1.55; }
    button { cursor: pointer; border: 1px solid #60749c; border-radius: 999px; padding: 9px 15px; color: #eef3ff; background: #293852; }
    button:hover { background: #35496d; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
    .card, section { border: 1px solid #2d3545; background: rgba(21, 25, 35, .86); border-radius: 16px; padding: 18px; box-shadow: 0 12px 32px rgba(0,0,0,.14); }
    .metric { font-size: 2rem; font-weight: 700; }
    .muted { color: #8994aa; font-size: .9rem; }
    section { margin-top: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #2d3545; vertical-align: top; }
    th { color: #9eabc1; font-size: .78rem; text-transform: uppercase; letter-spacing: .07em; }
    a { color: #9fc2ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    #notice { min-height: 1.4em; color: #9fc2ff; }
    @media (max-width: 720px) { header { align-items: start; flex-direction: column; } table { font-size: .9rem; } }
  </style>
</head>
<body>
<main>
  <header>
    <div><div class="muted">oflow · local-only read model</div><h1>Planning cockpit</h1><p id="project">Loading cached project context…</p></div>
    <div><button id="reload">Reload local view</button> <button id="refresh">Request sync</button></div>
  </header>
  <div id="notice" role="status"></div>
  <div class="grid" id="metrics"></div>
  <section><h2>Work items</h2><div id="work">Loading…</div></section>
  <section><h2>Merge requests</h2><div id="mrs">Loading…</div></section>
  <section><h2>Delivery and planning</h2><div id="delivery">Loading…</div></section>
  <section><h2>Sync history</h2><div id="history">Loading…</div></section>
</main>
<script>
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const link = (title, url) => url ? '<a href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(title) + '</a>' : esc(title);
const age = (seconds) => seconds == null ? 'unknown' : seconds < 60 ? 'under a minute' : Math.floor(seconds / 60) + 'm ago';
async function load() {
  const response = await fetch('/api/data');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load local read model');
  const status = data.status;
  document.querySelector('#project').textContent = data.project ? data.project.path + ' · cache ' + age(status.latestSync?.ageSeconds) : 'No local sync snapshot yet';
  const counts = status.counts;
  document.querySelector('#metrics').innerHTML = [
    ['Work items', counts.workItems], ['Merge requests', counts.mergeRequests], ['Pipelines', counts.pipelines], ['Iterations', counts.iterations], ['Snapshots', counts.syncSnapshots]
  ].map(([label, value]) => '<div class="card"><div class="muted">' + esc(label) + '</div><div class="metric">' + esc(value) + '</div></div>').join('');
  document.querySelector('#work').innerHTML = data.workItems.length ? '<table><tr><th>Story</th><th>State</th><th>Planning</th><th>Owner</th></tr>' + data.workItems.map((item) => '<tr><td>' + link('#' + item.iid + ' ' + item.title, item.webUrl) + '</td><td>' + esc(item.state) + '</td><td>' + esc([item.milestone, item.iteration].filter(Boolean).join(' · ') || 'Unscheduled') + '</td><td>' + esc(item.assignees.join(', ') || 'Unassigned') + '</td></tr>').join('') + '</table>' : '<p class="muted">No work items in the latest snapshot.</p>';
  document.querySelector('#mrs').innerHTML = data.mergeRequests.length ? '<table><tr><th>MR</th><th>State</th><th>Branches</th></tr>' + data.mergeRequests.map((item) => '<tr><td>' + link('!' + item.iid + ' ' + item.title, item.webUrl) + '</td><td>' + esc((item.draft ? 'Draft · ' : '') + (item.state || 'unknown')) + '</td><td>' + esc((item.sourceBranch || '?') + ' → ' + (item.targetBranch || '?')) + '</td></tr>').join('') + '</table>' : '<p class="muted">No merge requests in the latest snapshot.</p>';
  document.querySelector('#delivery').innerHTML = '<p><strong>Pipelines:</strong> ' + esc(data.pipelines.map((item) => item.status || 'unknown').join(', ') || 'none') + '</p><p><strong>Iterations:</strong> ' + esc(data.iterations.map((item) => item.title || ('#' + item.iid)).join(', ') || 'none') + '</p><p><strong>Labels:</strong> ' + esc(data.planning.labels.map((item) => item.name).join(', ') || 'none') + '</p><p><strong>Milestones:</strong> ' + esc(data.planning.milestones.map((item) => item.title).join(', ') || 'none') + '</p>';
  document.querySelector('#history').innerHTML = data.syncHistory.length ? '<table><tr><th>Generated</th><th>Source</th><th>Counts</th><th>Warnings</th></tr>' + data.syncHistory.map((item) => '<tr><td>' + esc(item.generatedAt) + '</td><td>' + esc(item.source) + '</td><td>' + esc(item.stats.workItems + ' work · ' + item.stats.mergeRequests + ' MR · ' + item.stats.pipelines + ' pipelines') + '</td><td>' + esc(item.warningCount) + '</td></tr>').join('') + '</table>' : '<p class="muted">No sync history yet.</p>';
  document.querySelector('#notice').textContent = status.invalidation.at ? 'Read model marked stale: ' + status.invalidation.reason : status.refreshRequest.at ? 'Sync requested locally; run oflow sync --refresh.' : '';
}
document.querySelector('#reload').addEventListener('click', () => load().catch((error) => { document.querySelector('#notice').textContent = error.message; }));
document.querySelector('#refresh').addEventListener('click', async () => { const response = await fetch('/api/refresh', { method: 'POST' }); const result = await response.json(); document.querySelector('#notice').textContent = result.message; });
load().catch((error) => { document.querySelector('#notice').textContent = error.message; });
</script>
</body>
</html>`;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function writeText(response: ServerResponse, status: number, value: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(value);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(new OflowError("Could not start the local dashboard: " + error.message, "DASHBOARD_START_FAILED"));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
