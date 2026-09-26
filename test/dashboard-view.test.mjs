import { test } from "node:test";
import vm from "node:vm";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dashboardViewHtml } from "../dist/dashboard-view.js";

const html = dashboardViewHtml();

// Run the served browser script with local DOM and HTTP seams; no GitLab calls.
function pageHarness(data = {}, { responses = {}, hash = "", clipboard } = {}) {
  const elements = new Map();
  const element = () => ({
    innerHTML: "", textContent: "", className: "", value: "", disabled: false,
    dataset: {}, listeners: new Map(), children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this[name] = value; },
    getAttribute(name) { return this[name]; },
    hasAttribute(name) { return name === "data-copy" ? this.dataset.copy !== undefined : this[name] !== undefined; },
    contains() { return true; },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    append(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return []; },
    querySelector(selector) { return get(selector.slice(1)); },
    focus() {},
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const requests = [];
  const document = {
    getElementById: get, querySelectorAll: () => [], createElement: element,
    addEventListener() {},
  };
  const context = vm.createContext({
    document, location: { hash }, window: { addEventListener() {} },
    navigator: { clipboard }, URL, console, setTimeout, clearTimeout,
    fetch: async (path, options) => {
      requests.push({ path, options });
      const response = await (responses[path] ?? { data });
      if (response.error) throw response.error;
      return {
        ok: response.status == null || response.status < 400,
        status: response.status ?? 200,
        text: async () => JSON.stringify(response.data),
      };
    },
  });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.ok(script.includes("window.addEventListener('hashchange'"), "page bootstrap boundary exists");
  new vm.Script(script.split("window.addEventListener('hashchange'")[0]).runInContext(context);
  return { context, get, requests, element, evaluate: (expression) => vm.runInContext(expression, context) };
}

test("the shell keeps the core workflow views", () => {
  for (const id of ["overview", "work", "delivery", "planning", "capabilities", "auth", "diagnostics", "lifecycle", "tour"]) {
    assert.match(html, new RegExp("id: '" + id + "'"), "missing view: " + id);
  }
});

test("the shell references every dashboard API route it consumes", () => {
  for (const path of [
    "api/data",
    "api/capabilities",
    "api/check-api",
    "api/auth/status",
    "api/plans",
    "api/verification",
    "api/audit",
  ]) {
    assert.ok(html.includes("/" + path), "missing API path: " + path);
  }
});

test("the page never offers a token input", () => {
  assert.equal(/<input[^>]+(?:name|id)=["'][^"']*(?:token|password|credential)/i.test(html), false, "search controls must not become credential inputs");
  assert.equal(/type=["']?password/i.test(html), false);
});

test("the page loads no cross-origin asset", () => {
  const external = html.match(/(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']+/gi) ?? [];
  assert.deepEqual(external, [], "unexpected external asset reference");
  assert.equal(/@import\s+url\(/i.test(html), false);
  assert.equal(/url\(\s*['"]?https?:/i.test(html), false);
});

test("the page uses event listeners rather than inline handlers", () => {
  const fetchCalls = html.match(/fetch\(/g) ?? [];
  assert.ok(fetchCalls.length > 0);
  assert.equal(/onclick\s*=/i.test(html), false, "inline handlers are not allowed");
  assert.match(html, /addEventListener\('hashchange'/);
});

test("a hostile table cell is rendered as text, not markup", () => {
  // Execute the page's own helper definitions instead of regexing their source:
  // the invariant under test is that a GitLab-controlled string cannot become
  // markup in the DOM, not that a particular spelling appears in the file.
  const { esc, cell, rawCell, table } = pageHarness().evaluate("({ esc, cell, rawCell, table })");

  const payload = '<img src=x onerror="window.__pwned=1">';
  const rendered = cell(payload);
  assert.equal(rendered.includes("<"), false, "angle brackets must be escaped");
  assert.equal(rendered.includes(">"), false);
  assert.ok(rendered.includes("&lt;img"), "payload must survive as escaped text");

  // Non-string values must be safe too.
  assert.equal(cell(null), "");
  assert.equal(cell(undefined), "");
  assert.equal(cell(0), "0");

  // Only the explicit opt-in may emit raw markup.
  assert.equal(cell(rawCell("<b>ok</b>")), "<b>ok</b>");
  assert.equal(esc("a&b"), "a&amp;b");

  // End to end through table(): a hostile GitLab string must not reach the DOM
  // as markup even when a caller forgets to escape it.
  const row = table(["Item"], [[payload]]);
  assert.equal(row.includes("<img"), false, "table must escape untrusted cells");
  assert.ok(row.includes("&lt;img"), "hostile cell must survive as text");
  // A caller that opts in still gets working markup.
  assert.match(table(["Item"], [[rawCell("<code>ok</code>")]]), /<td><code>ok<\/code><\/td>/);
  // Headers are escaped too.
  assert.equal(table([payload], []).includes("<img"), false);
});

test("every table cell passes through the escaping helper", () => {
  assert.match(html, /cells\.map\(\(entry\) => '<td>' \+ cell\(entry\)/);
  assert.equal(/cells\.map\(\(cell\) => '<td>' \+ cell/.test(html), false);
});

test("overview notes describe the read model and snapshot state honestly", async () => {
  const render = (status) => renderOverviewHtml({ status });

  const empty = await render({ state: "missing", databaseExists: false, latestSync: null, counts: {} });
  assert.match(empty, /no snapshot yet/);
  assert.match(empty, /not created yet/);
  assert.equal(/unknown/.test(empty), false, "no sync should not read as 'unknown'");

  const ready = await render({
    state: "ready", databaseExists: true,
    latestSync: { ageSeconds: 30 }, counts: { workItems: 3 },
  });
  assert.match(ready, /sqlite ready/);
  assert.match(ready, /under a minute/);
  assert.equal(/no snapshot yet/.test(ready), false);
  assert.equal(/not created yet/.test(ready), false);
});

test("a __html field in API data cannot forge raw markup", () => {
  // rawCell() tags with a Symbol, which JSON cannot express, so a hostile
  // field in a GitLab-sourced response stays inert text.
  const { cell, table, rawCell } = pageHarness().evaluate("({ cell, table, rawCell })");

  const forged = { __html: '<img src=x onerror="window.__pwned=1">' };
  assert.equal(cell(forged).includes("<img"), false, "a string key must not opt out of escaping");
  assert.equal(table(["Item"], [[forged]]).includes("<img"), false);

  // The explicit opt-in still works, which is the only path to raw markup.
  assert.match(cell(rawCell("<b>ok</b>")), /<b>ok<\/b>/);
});

test("timestamps render compactly and never as injectable markup", () => {
  // The raw ISO string occupied 246px of a ~1365px viewport. `when` compacts
  // it, and must degrade to the original text rather than throw or emit
  // markup when the input is hostile or unparseable.
  const { cell, when } = pageHarness().evaluate("({ cell, when })");

  const now = Date.now();
  assert.equal(when(new Date(now - 30_000).toISOString()), "just now");
  assert.equal(when(new Date(now - 5 * 60_000).toISOString()), "5m ago");
  assert.equal(when(new Date(now - 3 * 3_600_000).toISOString()), "3h ago");
  assert.equal(when(new Date(now - 4 * 86_400_000).toISOString()), "4d ago");

  // Unparseable, empty, and future input must pass through unchanged...
  assert.equal(when("not-a-date"), "not-a-date");
  assert.equal(when(""), "");
  assert.equal(when(undefined), "");
  assert.equal(when(new Date(now + 86_400_000).toISOString()).includes("ago"), false);
  // `when` returns text, not markup; the escaping happens at the cell
  // boundary, which is where every call site routes through. Assert the real
  // contract: a hostile "timestamp" reaching a table cell stays text.
  const hostile = when('<img src=x onerror="window.__pwned=1">');
  assert.equal(cell(hostile).includes("<img"), false, "hostile timestamp must not become markup");
  assert.ok(cell(hostile).includes("&lt;img"), "hostile timestamp must survive as text");
});


// Drives the real renderOverview so assertions are about rendered output,
// not a regex restated in the test.
async function renderOverviewHtml(data) {
  const page = pageHarness(data);
  const host = page.get("view");
  await page.context.renderOverview(host);
  return host.innerHTML;
}

const overviewData = (warnings) => ({
  status: { state: "ready", databaseExists: true, counts: { workItems: 1, mergeRequests: 0, pipelines: 0, iterations: 0, syncSnapshots: 1 } },
  project: null,
  repository: null,
  workItems: [],
  mergeRequests: [],
  pipelines: [],
  iterations: [],
  planning: { labels: [], milestones: [], boards: [] },
  syncHistory: [],
  warnings,
});

// Card text keyed by its label, so a caption can be attributed to the card
// that owns it. Splitting on the card boundary is simpler and less brittle
// than a tempered-greedy regex over nested divs.
const cardsByLabel = (html) => {
  const out = new Map();
  for (const chunk of html.split('<div class="card">').slice(1)) {
    const label = /<div class="card-label">([^<]*)<\/div>/.exec(chunk)?.[1] ?? "";
    out.set(label, chunk.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }
  return out;
};

test("a scope gap is attributed to the card that owns that source", async () => {
  // A pipelines-only gap must not annotate the Merge requests count: a
  // readable zero would then look like an unreadable one.
  const out = await renderOverviewHtml(overviewData([
    "Could not read project labels: GitLab API 403",
    "Could not read pipelines: GitLab API 403",
  ]));
  assert.ok(out.includes("cannot read"), "the gap section must render");
  assert.equal((out.match(/class="gap-source"/g) ?? []).length, 2, "both gaps listed");
  // Per-card attribution, not one blanket caption on whichever card came first.
  assert.equal(cardsByLabel(out).get("Merge requests").includes("not readable"), false,
    "Merge requests is readable and must not carry a gap caption");
  assert.equal(cardsByLabel(out).get("Pipelines").includes("not readable"), true,
    "Pipelines is unreadable and must say so");
  assert.equal(cardsByLabel(out).get("Labels").includes("not readable"), true,
    "Labels is unreadable and must say so");
  assert.equal(cardsByLabel(out).get("Iterations").includes("not readable"), false);
  assert.equal(cardsByLabel(out).get("Milestones").includes("not readable"), false);
  // The bullet leads with the source and status, not the encoded URL.
  assert.ok(out.includes(">pipelines</span>"), "gap bullet must name the source");
  assert.ok(out.includes("HTTP 403"), "gap bullet must show the status :: " + out.slice(out.indexOf("<li>"), out.indexOf("<li>")+300));
  assert.ok(out.includes("<details>"), "the raw API text must be collapsed");
});

test("advisory notes are not presented as scope gaps", async () => {
  const out = await renderOverviewHtml(overviewData([
    "Type coverage: REST lists issue and task types only",
    "The current Git remote differs from .oflow/config.json; using the current remote.",
    "Cached snapshot was created on branch main; current branch is feat/x",
  ]));
  assert.equal(out.includes("cannot read"), false, "advisory notes are not scope gaps");
  assert.equal(out.includes("not readable with this token"), false);
  // The class is shared with the gap list; what must be absent is the gap
  // heading and the per-card caption, checked above.
  assert.equal(out.includes('class="gap-source"'), false, "no gap source rows");
  // They are still surfaced, just not as a readability failure.
  assert.ok(out.includes("Sync warnings"), "advisories get their own neutral section");
  assert.ok(out.includes("Type coverage"), "advisory text is still shown");
});

test("a gap status is read from the real marker, not guessed", async () => {
  // A loose 3-digit scan can pull a number out of the encoded project path or
  // a JSON body and present it as the HTTP status.
  const decoy = await renderOverviewHtml(overviewData([
    "Could not read pipelines: refused for /projects/2026-403-team%2Fdemo/pipelines",
  ]));
  assert.equal(decoy.includes("HTTP 403"), false, "must not invent a status from the path");
  assert.ok(decoy.includes(">pipelines</span>"), "the source is still reported");
});

test("a missing warnings field does not invent a gap", async () => {
  const out = await renderOverviewHtml({ ...overviewData([]), warnings: undefined });
  assert.equal(out.includes("cannot read"), false);
  assert.equal(out.includes("not readable"), false);
});

test("gap warning text is escaped, not rendered as markup", async () => {
  const out = await renderOverviewHtml(
    overviewData(['Could not read <img src=x onerror="window.__pwned=1">']),
  );
  assert.equal(out.includes("<img"), false, "warning text must be escaped");
  assert.ok(out.includes("&lt;img"), "hostile warning must survive as text");
});

test("a gap on one source does not annotate a readable neighbour", async () => {
  // The two-gap case above cannot catch blanket captioning: with pipelines
  // unreadable too, a blanket caption on Pipelines looks identical to correct
  // attribution. Only a labels-only gap separates them.
  const out = await renderOverviewHtml(overviewData([
    "Could not read project labels: GitLab API 403",
  ]));
  const cards = cardsByLabel(out);
  assert.equal(cards.get("Pipelines").includes("not readable"), false,
    "Pipelines is readable; it must not carry a caption");
  assert.equal(cards.get("Merge requests").includes("not readable"), false);
  assert.equal(cards.get("Iterations").includes("not readable"), false);
  assert.equal(cards.get("Labels").includes("not readable"), true,
    "Labels is the unreadable one and must say so");
});

test("the served page keeps the escape in the gap status regex", () => {
  // dashboardViewHtml is a template literal, so a single \d in the source is
  // cooked to a literal "d" and the served page silently ships
  // /GitLab API (d{3})/, which never matches. The source looks correct and
  // every other test still passes, so assert on the SERVED string.
  assert.ok(
    html.includes("GitLab API (\\d{3})"),
    "served page lost the escape: a single \\d inside the template literal cooks to d",
  );
  assert.equal(
    html.includes("GitLab API (d{3})"),
    false,
    "served page contains the cooked regex, which matches a literal d",
  );
});

test("every card label the tests assert on is actually rendered", async () => {
  // cardsByLabel returns undefined for a missing label, and `.includes` on
  // undefined throws a TypeError that reads like a product failure. Assert
  // the labels exist so a typo names itself.
  const cards = cardsByLabel(await renderOverviewHtml(overviewData([])));
  for (const label of [
    "Work items", "Merge requests", "Pipelines", "Iterations",
    "Snapshots", "Read model", "Labels", "Milestones", "Boards",
  ]) {
    assert.ok(cards.has(label), `expected a card labelled "${label}"`);
  }
});

test("no lone backslash in the served page's source template", () => {
  // The general form of the escape bug: a doubled backslash in source cooks
  // to one in the served page, so a single one silently becomes a literal.
  // Counting total backslashes is not the invariant (2 in source -> 1 served
  // is correct); the invariant is that none of them is unpaired. A comment
  // mentioning a backslash would trip this, so the region is code only.
  const src = readFileSync(new URL("../src/dashboard-view.ts", import.meta.url), "utf8");
  const region = src.slice(
    src.indexOf("return `<!doctype html>"),
    src.lastIndexOf("</html>") + "</html>".length,
  );
  const lone = region.match(/(?<!\\)\\(?!\\)/g) ?? [];
  assert.deepEqual(
    lone,
    [],
    "unpaired backslash in the dashboardViewHtml template literal: it cooks away in the served page",
  );
});

test("opening diagnostics does not probe GitLab until explicitly requested", async () => {
  const page = pageHarness();
  await page.context.renderDiagnostics(page.get("view"));
  assert.deepEqual(page.requests, []);
  assert.match(page.get("view").innerHTML, /API check|diagnostic/i);
});

test("unknown navigation falls back to the overview and only reads local data", async () => {
  const page = pageHarness(overviewData([]));
  await page.context.show("not-a-view");
  assert.match(page.get("view-title").textContent, /overview/i);
  assert.deepEqual(page.requests.map(({ path }) => path), ["/api/data", "/api/actions", "/api/audit", "/api/verification"]);
  assert.ok(page.requests.every(({ options }) => !options?.method || options.method === "GET"));
});

test("a failed local data request is visible instead of looking like empty work", async () => {
  const page = pageHarness({}, {
    responses: { "/api/data": { status: 500, data: { error: "Snapshot unavailable" } } },
  });
  await page.context.show("overview");
  assert.match(page.get("banner").textContent, /Snapshot unavailable/);
  assert.doesNotMatch(page.get("view").innerHTML, /No cached work items/);
});

const workItems = [
  { iid: 12, title: "Build search", state: "opened", assignees: ["developer"], labels: ["frontend"], milestone: "Release one", iteration: "Sprint A" },
  { iid: 13, title: "Fix delivery", state: "opened", assignees: [], labels: ["backend"] },
  { iid: 14, title: "Search docs", state: "closed", assignees: ["writer"], labels: [] },
];

test("work search finds identifiers, owners, labels and timeboxes case-insensitively", () => {
  const { filterWork } = pageHarness().evaluate("({ filterWork })");
  for (const search of ["12", " BUILD ", "DEVELOPER", "frontend", "Release one", "Sprint A"]) {
    assert.deepEqual(Array.from(filterWork(workItems, search, "all", "all"), (item) => item.iid), [12], search);
  }
});

test("work filters combine state and ownership rather than broadening search", () => {
  const { filterWork } = pageHarness().evaluate("({ filterWork })");
  assert.deepEqual(Array.from(filterWork(workItems, "", "opened", "unassigned"), (item) => item.iid), [13]);
  assert.deepEqual(Array.from(filterWork(workItems, "search", "opened", "assigned"), (item) => item.iid), [12]);
  assert.equal(filterWork(workItems, "missing", "all", "all").length, 0);
});

test("changing work filters updates the queue without another HTTP request", async () => {
  const page = pageHarness({ ...overviewData([]), workItems });
  page.get("work-state").value = "all";
  page.get("work-owner").value = "all";
  await page.context.renderWork(page.get("view"));
  assert.equal(page.get("work-count").textContent, "3 of 3 cached items");
  page.get("work-search").value = "delivery";
  page.get("work-search").listeners.get("input")();
  assert.equal(page.get("work-count").textContent, "1 of 3 cached items");
  assert.match(page.get("work-results").innerHTML, /Fix delivery/);
  assert.doesNotMatch(page.get("work-results").innerHTML, /Build search/);
  page.get("work-owner").value = "assigned";
  page.get("work-owner").listeners.get("change")();
  assert.match(page.get("work-results").innerHTML, /No matching work items/);
  assert.equal(page.requests.length, 1);
});

test("external links permit HTTP(S) but reject executable and relative URLs", () => {
  const { link } = pageHarness().evaluate("({ link })");
  for (const url of ["javascript:alert(1)", "data:text/html,hello", "//example.test/x", "/api/refresh", "file:///tmp/example"]) {
    assert.doesNotMatch(link("<unsafe>", url), /<a\b/, url);
    assert.match(link("<unsafe>", url), /&lt;unsafe&gt;/);
  }
  const safe = link('Read "story"', "https://gitlab.example.test/demo/-/issues/12?x=1&y=2");
  assert.match(safe, /href="https:\/\/gitlab\.example\.test/);
  assert.match(safe, /&amp;y=2/);
  assert.match(safe, /rel="[^"]*noopener/);
});

test("story handoff commands use validated issue numbers and never execute", () => {
  const page = pageHarness();
  const { workTable } = page.evaluate("({ workTable })");
  const out = workTable(workItems);
  assert.match(out, /data-copy="oflow context --story 12 --json"/);
  assert.match(out, /data-copy="oflow assess --story 12 --json"/);
  const hostile = workTable([{ ...workItems[0], iid: "12; echo unsafe", title: "<img src=x>", assignees: ["<svg>"] }]);
  assert.doesNotMatch(hostile, /data-copy=/);
  assert.doesNotMatch(hostile, /<img|<svg/);
  assert.deepEqual(page.requests, []);
});

test("delivery shows branches and cached pipeline evidence without claiming current verification", async () => {
  const page = pageHarness({ ...overviewData([]),
    mergeRequests: [{ iid: 2, title: "Deliver search", state: "opened", sourceBranch: "feature/search", targetBranch: "main", draft: true }],
    pipelines: [{ id: 9, status: "failed", ref: "feature/search", sha: "abcdef1234567890" }],
  });
  await page.context.renderDelivery(page.get("view"));
  const out = page.get("view").innerHTML;
  for (const expected of [/Deliver search/, /Draft/, /feature\/search → main/, /abcdef123456/, /does not prove the current head/]) assert.match(out, expected);
  assert.match(cardsByLabel(out).get("Failed pipelines"), /1/);
});

test("planning displays real timeboxes, board lists and label counts", async () => {
  const page = pageHarness({ ...overviewData([]),
    iterations: [{ title: "Sprint 7", state: "current", startDate: "2026-09-21", dueDate: "2026-10-02" }],
    planning: {
      milestones: [{ title: "Autumn release", state: "active", dueDate: "2026-10-30" }],
      boards: [{ name: "Delivery board", lists: [{ id: 1, label: "In progress" }] }],
      labels: [{ name: "<frontend>", openIssues: 0, closedIssues: 2 }],
    },
  });
  await page.context.renderPlanning(page.get("view"));
  const out = page.get("view").innerHTML;
  for (const text of ["Sprint 7", "2026-10-02", "Autumn release", "Delivery board", "In progress", "&lt;frontend&gt;", "<td>0</td>"]) assert.ok(out.includes(text), text);
  assert.doesNotMatch(out, /<frontend>/);
});

test("snapshot context distinguishes invalidated and truncated data from live project totals", async () => {
  const page = pageHarness({ ...overviewData([]), workItems: workItems.slice(0, 1), workItemsMayBeTruncated: true,
    query: { state: "opened", issueLimit: 1, issueFilters: { assignee: "developer" } },
    status: { state: "ready", counts: { workItems: 99 }, latestSync: { ageSeconds: 7200 }, invalidation: { at: "2026-09-26T00:00:00Z", reason: "Remote change" } },
  });
  await page.context.renderOverview(page.get("view"));
  const out = page.get("view").innerHTML;
  assert.match(out, /not live/);
  assert.match(out, /not project totals/);
  assert.match(out, /may be truncated/);
  assert.match(out, /Invalidated/);
  assert.match(cardsByLabel(out).get("Work items"), /^1 Work items/);
  assert.doesNotMatch(cardsByLabel(out).get("Work items"), /99/);
});

test("copying a handoff writes only to the clipboard and restores its button", async () => {
  const copied = [];
  const page = pageHarness({}, { clipboard: { writeText: async (value) => copied.push(value) } });
  const host = page.get("view");
  const button = page.element();
  button.dataset.copy = "oflow context --story 12 --json";
  button.textContent = "Copy";
  page.context.bindInteractions(host);
  await host.listeners.get("click")({ target: { closest: () => button } });
  assert.deepEqual(copied, ["oflow context --story 12 --json"]);
  assert.deepEqual(page.requests, []);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Copy");
  assert.match(page.get("notice").textContent, /copied/i);
});

test("clipboard denial provides manual-copy guidance instead of executing a command", async () => {
  const page = pageHarness();
  const host = page.get("view");
  const button = page.element();
  button.dataset.copy = "oflow sync --refresh";
  button.textContent = "Copy";
  page.context.bindInteractions(host);
  await host.listeners.get("click")({ target: { closest: () => button } });
  assert.match(page.get("banner").textContent, /Select and copy/);
  assert.equal(button.disabled, false);
  assert.deepEqual(page.requests, []);
});

test("request refresh posts only a local request and explains the terminal sync", async () => {
  const page = pageHarness({}, { responses: { "/api/refresh": { data: { accepted: true } } } });
  const host = page.get("view");
  const button = page.element();
  button.textContent = "Request refresh";
  page.context.bindInteractions(host);
  await host.listeners.get("click")({ target: { closest: () => button } });
  assert.deepEqual(page.requests.map(({ path, options }) => [path, options.method]), [["/api/refresh", "POST"]]);
  assert.match(page.get("notice").textContent, /Run oflow sync --refresh in your terminal/);
  assert.equal(button.textContent, "Refresh requested");
  assert.equal(button.disabled, false);
});

test("a late overview response cannot replace the newly selected tour", async () => {
  let resolveData;
  const delayed = new Promise((resolve) => { resolveData = resolve; });
  const page = pageHarness({}, { responses: { "/api/data": delayed } });
  const pending = page.context.show("overview");
  await page.context.show("tour");
  const selected = page.get("view").children[0];
  assert.match(selected.innerHTML, /Start with context/);
  resolveData({ data: overviewData([]) });
  await pending;
  assert.equal(page.get("view").children[0], selected);
  assert.equal(page.get("view-title").textContent, "What oflow does");
  assert.equal(page.get("view")["aria-busy"], "false");
});

test("reload local data repeats only the current local read", async () => {
  const page = pageHarness(overviewData([]));
  await page.context.show("overview");
  const reload = page.get("view-actions").children[0];
  assert.equal(reload.textContent, "Reload local data");
  await reload.listeners.get("click")();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(page.requests.map(({ path }) => path), ["/api/data", "/api/actions", "/api/audit", "/api/verification", "/api/data", "/api/actions", "/api/audit", "/api/verification"]);
  assert.ok(page.requests.every(({ options }) => !options?.method || options.method === "GET"));
});

test("agent handoff explains story-specific actions without fetching or choosing work", () => {
  const harness = pageHarness();
  const host = harness.element();
  harness.evaluate("renderAgentHandoff")(host, { workItems: [{iid:42,title:'Review flow',state:'opened'}] });
  assert.match(host.innerHTML, /Share its output with your agent/);
  assert.match(host.innerHTML, /Choose a cached story/);
  assert.match(harness.get('handoff-steps').innerHTML, /No story is selected automatically/);
  harness.get('handoff-story').value = '0';
  harness.get('handoff-story').listeners.get('change')();
  const output = harness.get('handoff-steps').innerHTML;
  for (const action of ['start','assess','handoff']) assert.ok(output.includes('data-copy="oflow '+action+' --story 42 --json"'));
  assert.match(output, /does not run your test suite/);
  assert.match(output, /branch and changed files/);
  assert.match(output, /nothing runs in this browser/);
  assert.deepEqual(harness.requests, []);
  harness.get('handoff-story').value = '';
  harness.get('handoff-story').listeners.get('change')();
  assert.doesNotMatch(harness.get('handoff-steps').innerHTML, /data-copy/);
});

test("agent handoff rejects invalid IDs and escapes remote story titles", () => {
  const harness = pageHarness();
  const host = harness.element();
  harness.evaluate('renderAgentHandoff')(host, {workItems:[{iid:'42; evil',title:'invalid'},{iid:-1,title:'negative'},{iid:7,title:'<img src=x onerror=evil>'}]});
  assert.doesNotMatch(host.innerHTML, /<img|42; evil|negative/);
  assert.match(host.innerHTML, /&lt;img/);
  harness.get('handoff-story').value = '0';
  harness.get('handoff-story').listeners.get('change')();
  assert.match(harness.get('handoff-steps').innerHTML, /oflow handoff --story 7 --json/);
  assert.doesNotMatch(harness.get('handoff-steps').innerHTML, /<img/);
  harness.evaluate('renderAgentHandoff')(host, {});
  assert.match(harness.get('handoff-steps').innerHTML, /No valid cached stories/);
});

test('story routes open a connected workspace and preserve the route when reloading', async () => {
  const page = pageHarness({workItems:[{iid:42,title:'Example',labels:[],assignees:[]} ]}, {responses:{'/api/actions':{data:{jobs:[]}}}});
  await page.evaluate("show('story/42')");
  assert.equal(page.get('view-title').textContent, 'Story #42');
  assert.ok(page.requests.every(({options}) => !options?.method || options.method === 'GET'));
  const reload = page.get('view-actions').children[0];
  await reload.listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.get('view-title').textContent, 'Story #42');
});

test('action console requires explicit launch and configured-check acknowledgement', async () => {
  const page = pageHarness({}, {responses:{'/api/actions':{data:{jobs:[]}}}});
  const host=page.element();
  await page.evaluate('renderActionConsole')(host);
  assert.deepEqual(page.requests.map(r=>r.path), ['/api/actions']);
  assert.equal(page.get('run-checks').disabled,true);
  page.get('run-checks').listeners.get('click')();
  assert.equal(page.requests.length,1);
  page.get('run-refresh').listeners.get('click')();
  await new Promise(resolve=>setImmediate(resolve));
  const writes=page.requests.filter(r=>r.options?.method==='POST');
  assert.equal(writes.length,1);
  assert.deepEqual(JSON.parse(writes[0].options.body),{action:'refresh'});
  host.dispose();
});
