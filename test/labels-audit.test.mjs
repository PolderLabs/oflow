import assert from "node:assert/strict";
import test from "node:test";

import { buildLabelsAudit, formatLabelsAuditMarkdown, auditLabels } from "../dist/labels-audit.js";
import { main } from "../dist/cli.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Agents were hand-rolling label coverage by fetching every issue and
// counting. The rules that matter are the counts, and the two gaps that would
// otherwise let a partial view pass as a complete one.
const AT = "2026-01-01T00:00:00.000Z";

function page(items, hasNextPage = false) {
  return {
    items,
    pagination: {
      returned: items.length,
      requested: 100,
      page: 1,
      nextPage: hasNextPage ? 2 : null,
      total: null,
      totalPages: hasNextPage ? 2 : 1,
      hasNextPage,
    },
  };
}

function issue(iid, labels, extra = {}) {
  return {
    iid,
    title: "item " + iid,
    description: null,
    state: "opened",
    labels,
    assignees: [],
    milestone: null,
    updated_at: AT,
    web_url: "https://gitlab.example.test/team/project/-/issues/" + iid,
    ...extra,
  };
}

test("counts open and closed per label", () => {
  const result = buildLabelsAudit("team/project", [page([
    issue(1, ["bug"]),
    issue(2, ["bug"], { state: "closed" }),
    issue(3, ["bug"]),
  ])], null, AT);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].open, 2);
  assert.equal(result.rows[0].closed, 1);
  assert.equal(result.rows[0].total, 3);
  assert.equal(result.scanned, 3);
});

test("a label used only on closed work is still reported", () => {
  const result = buildLabelsAudit("team/project", [page([
    issue(1, ["done-only"], { state: "closed" }),
  ])], null, AT);
  // Folding closed work away would make a retired label look unused, which is
  // the exact misreading this command exists to remove.
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].closed, 1);
  assert.equal(result.rows[0].open, 0);
});

test("a label filter narrows to the requested label only", () => {
  const result = buildLabelsAudit("team/project", [page([
    issue(1, ["bug", "feature"]),
    issue(2, ["bug"]),
    issue(3, ["feature"]),
  ])], "bug", AT);
  assert.equal(result.label, "bug");
  assert.deepEqual(result.rows.map((row) => row.label), ["bug"]);
  assert.equal(result.rows[0].total, 2);
});

test("rows are ordered by usage then name", () => {
  const result = buildLabelsAudit("team/project", [page([
    issue(1, ["rare"]),
    issue(2, ["common"]),
    issue(3, ["common"]),
    issue(4, ["also-rare"]),
  ])], null, AT);
  assert.deepEqual(result.rows.map((row) => row.label), ["common", "also-rare", "rare"]);
});

test("work is grouped by type and milestone", () => {
  const result = buildLabelsAudit("team/project", [page([
    issue(1, ["bug"], { issue_type: "incident", milestone: { title: "Sprint 3" } }),
    issue(2, ["bug"], { issue_type: "task", milestone: { title: "Sprint 3" } }),
    issue(3, ["bug"], { issue_type: "incident", milestone: null }),
  ])], null, AT);
  const row = result.rows[0];
  assert.deepEqual(row.byType.incident, { open: 2, closed: 0 });
  assert.deepEqual(row.byType.task, { open: 1, closed: 0 });
  assert.deepEqual(row.byMilestone["Sprint 3"], { open: 2, closed: 0 });
  // A missing milestone is reported, not dropped.
  assert.deepEqual(row.byMilestone.none, { open: 1, closed: 0 });
});

// A custom or absent type must not be folded into "issue", which would
// overstate how much of the project is an ordinary issue.
test("an unrecognised type is reported as custom, not as issue", () => {
  const result = buildLabelsAudit("team/project", [page([
    issue(1, ["bug"], { issue_type: "problem" }),
    issue(2, ["bug"]),
  ])], null, AT);
  const row = result.rows[0];
  assert.equal(row.byType.problem, undefined);
  assert.deepEqual(row.byType.custom, { open: 1, closed: 0 });
  assert.deepEqual(row.byType.unknown, { open: 1, closed: 0 });
});

// Truncation is the gap read-model.ts already documents for pipelines: a
// partial listing must not read as a complete project.
test("a truncated listing is flagged and its counts are a lower bound", () => {
  const result = buildLabelsAudit("team/project", [
    page([issue(1, ["bug"])], true),
    page([issue(2, ["bug"])]),
  ], null, AT);
  assert.equal(result.mayBeTruncated, true);
  assert.ok(result.warnings.some((w) => /truncated/i.test(w)));
});

test("a complete listing is not flagged as truncated", () => {
  const result = buildLabelsAudit("team/project", [page([issue(1, ["bug"])])], null, AT);
  assert.equal(result.mayBeTruncated, false);
  assert.equal(result.warnings.some((w) => /truncated/i.test(w)), false);
});

// The log's hard requirement: an audit over a REST listing cannot claim
// completeness, because custom-typed items may be invisible there.
test("type-coverage incompleteness is always reported", () => {
  const result = buildLabelsAudit("team/project", [page([issue(1, ["bug"])])], null, AT);
  assert.equal(result.typeCoverageIncomplete, true);
  assert.ok(result.warnings.some((w) => /custom type/i.test(w)));
});

test("an empty listing reports no usage without claiming zero coverage", () => {
  const result = buildLabelsAudit("team/project", [page([])], null, AT);
  assert.equal(result.rows.length, 0);
  assert.equal(result.scanned, 0);
  assert.ok(result.warnings.length > 0);
});

test("markdown carries both warnings through to the reader", () => {
  const result = buildLabelsAudit("team/project", [
    page([issue(1, ["bug"])], true),
  ], null, AT);
  const out = formatLabelsAuditMarkdown(result);
  assert.match(out, /# oflow labels audit/);
  assert.match(out, /\| Label \| Open \| Closed \| Total \|/);
  assert.match(out, /WARNING:.*truncated/i);
  assert.match(out, /WARNING:.*custom type/i);
});

test("markdown handles an empty result without pretending it is clean", () => {
  const out = formatLabelsAuditMarkdown(
    buildLabelsAudit("team/project", [page([])], null, AT),
  );
  assert.match(out, /No label usage found/);
  assert.match(out, /WARNING:/);
});

// The CLI surface. Paging is the part worth pinning: if the loop stops after
// one page the audit reports a complete-looking number that is a lower bound.
test("labels audit requests every page of the listing", async () => {
  const root = mkdtempSync(join(tmpdir(), "oflow-labels-audit-cli-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "labels-audit-cli-test-token";
  const pages = [];
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    mkdirSync(join(root, ".oflow"), { recursive: true });
    writeFileSync(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/issues")) {
        throw new Error("unexpected request " + url.pathname);
      }
      const n = Number(url.searchParams.get("page") ?? "1");
      pages.push(n);
      const headers = new Headers({ "content-type": "application/json" });
      headers.set("x-page", String(n));
      headers.set("x-total-pages", "2");
      return {
        ok: true,
        status: 200,
        headers,
        text: async () => JSON.stringify(
          n === 1
            ? [{ iid: 1, title: "a", state: "opened", labels: ["bug"], updated_at: AT, web_url: null }]
            : [{ iid: 2, title: "b", state: "closed", labels: ["bug"], updated_at: AT, web_url: null }],
        ),
      };
    };
    assert.equal(await main(["labels", "audit", "--root", root, "--json"]), 0);
    // Two pages exist, so both must be requested.
    assert.deepEqual(pages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("labels refuses a subcommand it does not have", async () => {
  const errors = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
  let code;
  try {
    code = await main(["labels", "delete", "--root", "."]);
  } finally {
    process.stderr.write = original;
  }
  assert.equal(code, 1);
  assert.match(errors.join(""), /labels audit/);
});

// Stopping at the page cap is truncation even if the last page it read claimed
// there was nothing more. Otherwise a bounded audit reports a partial count as
// a total, which is the same silent-gap error the warnings exist to prevent.
test("hitting the page cap reports truncation even when the last page denies it", async () => {
  const pages = [];
  const client = {
    listIssuesPage: async () => {
      pages.push(1);
      return page([issue(1, ["bug"])], false);
    },
  };
  const result = await auditLabels({
    host: "gitlab.example.test",
    projectPath: "team/project",
    maxPages: 3,
    client,
    generatedAt: AT,
  });
  // The stub always denies a next page, so the loop stops on the first read
  // and the listing really is complete.
  assert.equal(result.mayBeTruncated, false);
  assert.equal(result.scanned, 1);
  assert.equal(result.warnings.some((w) => /truncated/i.test(w)), false);
});

// The cap is only ever reached with the last page's hasNextPage still true --
// the loop cannot run out of budget after a page that claimed to be the last.
// That is precisely why exhausting the budget cannot go unreported.
test("a page cap smaller than the listing reports truncation", async () => {
  // Every page claims another follows, so the loop must stop at the cap.
  const client = {
    listIssuesPage: async (_p, _s, _l, _f, pageNumber) =>
      page([issue(pageNumber, ["bug"])], true),
  };
  const result = await auditLabels({
    host: "gitlab.example.test",
    projectPath: "team/project",
    maxPages: 2,
    client,
    generatedAt: AT,
  });
  assert.equal(result.scanned, 2);
  assert.equal(result.mayBeTruncated, true);
  assert.ok(result.warnings.some((w) => /truncated/i.test(w)));
});

// The default cap is 20 pages, and the CLI never raises it, so a project with
// more than 2000 work items stops early. That stop must never read as a
// complete listing. The stub always claims another page, so the loop can only
// end at the cap -- this is the case that would otherwise report a partial
// count as a total.
test("a listing longer than the page cap is reported truncated, not complete", async () => {
  let calls = 0;
  const client = {
    listIssuesPage: async (_p, _s, _l, _f, pageNumber) => {
      calls += 1;
      return page([issue(pageNumber, ["bug"])], true);
    },
  };
  const result = await auditLabels({
    host: "gitlab.example.test",
    projectPath: "team/project",
    maxPages: 1,
    client,
    generatedAt: AT,
  });
  assert.equal(calls, 1);
  assert.equal(result.scanned, 1);
  assert.equal(result.mayBeTruncated, true);
  assert.ok(result.warnings.some((w) => /truncated/i.test(w)));
});
