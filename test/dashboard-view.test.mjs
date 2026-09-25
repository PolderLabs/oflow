import { test } from "node:test";
import vm from "node:vm";
import assert from "node:assert/strict";

import { dashboardViewHtml } from "../dist/dashboard-view.js";

const html = dashboardViewHtml();

test("the shell renders all six views", () => {
  for (const id of ["overview", "capabilities", "auth", "diagnostics", "lifecycle", "tour"]) {
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
  assert.equal(/<input/i.test(html), false, "the dashboard must not contain any input element");
  assert.equal(/type=["']?password/i.test(html), false);
});

test("the page loads no cross-origin asset", () => {
  const external = html.match(/(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']+/gi) ?? [];
  assert.deepEqual(external, [], "unexpected external asset reference");
  assert.equal(/@import\s+url\(/i.test(html), false);
  assert.equal(/url\(\s*['"]?https?:/i.test(html), false);
});

test("the page performs no network request until the user asks", () => {
  const fetchCalls = html.match(/fetch\(/g) ?? [];
  assert.ok(fetchCalls.length > 0);
  assert.equal(/onclick\s*=/i.test(html), false, "inline handlers are not allowed");
  assert.match(html, /addEventListener\('hashchange'/);
});

test("a hostile table cell is rendered as text, not markup", () => {
  // Execute the page's own helper definitions instead of regexing their source:
  // the invariant under test is that a GitLab-controlled string cannot become
  // markup in the DOM, not that a particular spelling appears in the file.
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const start = script.indexOf("const esc = ");
  const end = script.indexOf("const table = ");
  assert.ok(start > -1 && end > start, "escaping helpers not found in the served page");
  const tableEnd = script.indexOf("const metric = ");
  const { esc, cell, rawCell, table } = new Function(
    script.slice(start, tableEnd) + "; return { esc, cell, rawCell, table };",
  )();

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
  // renderOverview writes into the host element it is handed, so a plain object
  // is enough: the notes are proven to follow the data, not to match a spelling.
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const render = async (status) => {
    const context = vm.createContext({
      document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
      location: { hash: "" },
      fetch: async () => ({ ok: true, text: async () => JSON.stringify({ status }) }),
      console, setTimeout, clearTimeout,
    });
    // Everything from the hashchange registration onward is bootstrap that
    // auto-runs on load; this test drives renderOverview directly.
    new vm.Script(script.split("window.addEventListener('hashchange'")[0]).runInContext(context);
    const host = { innerHTML: "" };
    await context.renderOverview(host);
    return host.innerHTML;
  };

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
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const start = script.indexOf("const esc = ");
  const end = script.indexOf("const metric = ");
  const { cell, table, rawCell } = new Function(
    script.slice(start, end) + "; return { cell, table, rawCell };",
  )();

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
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const start = script.indexOf("const esc = ");
  const end = script.indexOf("function renderTabs() ");
  assert.ok(start > -1 && end > start, "helpers not found in the served page");
  const { esc, cell, when } = new Function(
    script.slice(start, end) + "; return { esc, cell, when };",
  )();

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
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const start = script.indexOf("const esc = ");
  const end = script.indexOf("window.addEventListener('hashchange'");
  assert.ok(start > -1 && end > start, "page script not found");
  const host = { innerHTML: "" };
  const stubDocument = {
    getElementById: () => ({
      textContent: "",
      className: "",
      classList: { add() {}, remove() {} },
    }),
  };
  const stubFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  });
  const render = new Function(
    "document", "location", "fetch", "window",
    script.slice(start, end) + "; return renderOverview;",
  )(stubDocument, { hash: "" }, stubFetch, {});
  await render(host);
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

test("only unreadable sources are shown as a token scope gap", async () => {
  // A snapshot's warnings mix scope gaps ("Could not read pipelines", raised
  // by optionalFetch) with advisory notes that say nothing about readability
  // (type coverage, a drifted remote, a snapshot from another branch).
  // Rendering the second kind as "cannot read" is its own falsehood.
  const gap = await renderOverviewHtml(overviewData(["Could not read pipelines: GitLab API 403"]));
  assert.ok(gap.includes("cannot read"), "an unreadable source must be reported");
  assert.equal((gap.match(/<li>/g) ?? []).length, 1, "exactly one gap listed");
  assert.ok(gap.includes("1 source not readable"), "the count must be singular");

  const advisory = await renderOverviewHtml(overviewData([
    "Type coverage: REST lists issue and task types only",
    "The current Git remote differs from .oflow/config.json; using the current remote.",
    "Cached snapshot was created on branch main; current branch is feat/x",
  ]));
  assert.equal(advisory.includes("cannot read"), false, "advisory notes are not scope gaps");
  assert.equal(advisory.includes("gap-list"), false);
  assert.equal(advisory.includes("not readable"), false);

  // A missing warnings field must not invent a gap.
  const none = await renderOverviewHtml({ ...overviewData([]), warnings: undefined });
  assert.equal(none.includes("cannot read"), false);

  // Warning text is GitLab-influenced and must be escaped, not rendered.
  const hostile = await renderOverviewHtml(
    overviewData(['Could not read <img src=x onerror="window.__pwned=1">']),
  );
  assert.equal(hostile.includes("<img"), false, "warning text must be escaped");
  assert.ok(hostile.includes("&lt;img"), "hostile warning must survive as text");
});
