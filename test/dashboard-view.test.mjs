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
