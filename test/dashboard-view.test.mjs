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
  assert.equal((html.match(/<li>/g) ?? []).length, 2, "both gaps listed");
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
