import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { createIssueUpdatePlan, createBulkIssueLabelsPlan } from "../dist/plan.js";

const run = promisify(execFile);

// A label the project does not define cannot be added. oflow used to find
// that out only at verify time, after the plan had been approved and applied.
// These tests pin the plan-time rejection, so the failure arrives before
// anything is written.
async function withLabelFixture(pages, run_) {
  const root = await mkdtemp(join(tmpdir(), "oflow-label-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "label-test-token";
  const calls = [];
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    await mkdir(join(root, ".oflow"), { recursive: true });
    await writeFile(
      join(root, ".oflow", "config.json"),
      JSON.stringify({
        managedBy: "oflow",
        version: 1,
        project: { host: "gitlab.example.test", path: "team/project" },
      }),
    );
    let pageIndex = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(method + " " + url);
      // A real Headers instance: parsePagination relies on get() returning null
      // for an absent key, which a plain Map does not do.
      const body = (payload, headers = {}) => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json", ...headers }),
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      });
      if (url.includes("/labels")) {
        const spec = pages[Math.min(pageIndex, pages.length - 1)];
        pageIndex += 1;
        // The REST endpoint returns a bare array; truncation is signalled by
        // the x-* pagination headers, not by a wrapper object.
        const items = spec.names.map((name) => ({ id: 1, name, color: "#fff" }));
        return body(
          items,
          spec.hasNextPage
            ? { "x-page": "1", "x-total-pages": "2", "x-total": "250" }
            : { "x-page": "1", "x-total-pages": "1", "x-total": String(items.length) },
        );
      }
      if (url.endsWith("/issues/42")) {
        return body({
          iid: 42,
          title: "Choose a pod",
          description: "d",
          state: "opened",
          labels: [],
          assignees: [],
          updated_at: "2026-01-01T00:00:00Z",
        });
      }
      throw new Error("unstubbed " + method + " " + url);
    };
    return await run_(root, calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
}

function labels(names, hasNextPage = false) {
  return { names, hasNextPage };
}

test("adding a label the project does not define is refused before a plan exists", async () => {
  await withLabelFixture([labels(["bug", "feature"])], async (root) => {
    await assert.rejects(
      () => createIssueUpdatePlan(root, 42, { add_labels: "nope" }),
      (error) => {
        assert.equal(error.code, "UNKNOWN_ISSUE_LABEL");
        assert.match(error.message, /"nope"/);
        // The message must point at the fix, not just report the problem.
        assert.match(error.message, /oflow plan label create/);
        return true;
      },
    );
    // A refused plan must leave nothing behind to apply.
    assert.equal(existsSync(join(root, ".oflow", "state", "plans")), false);
  });
});

test("several missing labels are all named in one refusal", async () => {
  await withLabelFixture([labels(["bug"])], async (root) => {
    await assert.rejects(
      () => createIssueUpdatePlan(root, 42, { add_labels: "nope,also-missing" }),
      (error) => {
        assert.equal(error.code, "UNKNOWN_ISSUE_LABEL");
        assert.match(error.message, /"nope"/);
        assert.match(error.message, /"also-missing"/);
        return true;
      },
    );
  });
});

test("an existing label still plans normally", async () => {
  await withLabelFixture([labels(["bug", "feature"])], async (root) => {
    const stored = await createIssueUpdatePlan(root, 42, { add_labels: "bug" });
    assert.equal(stored.plan.operation.kind, "issue.update");
    assert.equal(stored.plan.operation.changes.add_labels, "bug");
  });
});

// A padded request is the same label: "--add-labels ' bug '" must not read as
// missing when the project stores "bug".
test("a padded label matches the stored name instead of reading missing", async () => {
  await withLabelFixture([labels(["bug"])], async (root) => {
    // The point is that this is not refused as missing; the plan stores the
    // request as written, which is how single-issue changes already behave.
    const stored = await createIssueUpdatePlan(root, 42, { add_labels: "  bug  " });
    assert.equal(stored.plan.state, "draft");
  });
});

// Truncating to the first page would accuse every label beyond it of being
// missing, so an incomplete list must refuse to judge instead.
test("a paginated label list refuses to judge rather than report false misses", async () => {
  await withLabelFixture([labels(["bug"], true)], async (root) => {
    await assert.rejects(
      () => createIssueUpdatePlan(root, 42, { add_labels: "bug" }),
      (error) => {
        assert.equal(error.code, "LABEL_LIST_INCOMPLETE");
        // It must not claim "bug" is missing; bug was on the first page.
        assert.doesNotMatch(error.message, /"bug" does not exist/);
        return true;
      },
    );
  });
});

// Removing an absent label is already the requested end state, so removal must
// not be blocked -- otherwise existing removal-only plans would start failing.
test("removing a label is not checked for existence", async () => {
  await withLabelFixture([labels(["bug"])], async (root) => {
    const stored = await createIssueUpdatePlan(root, 42, { remove_labels: "long-gone" });
    assert.equal(stored.plan.operation.changes.remove_labels, "long-gone");
  });
});

test("a bulk label plan applies the same existence check", async () => {
  await withLabelFixture([labels(["bug"])], async (root) => {
    await assert.rejects(
      () => createBulkIssueLabelsPlan(root, [42], { add_labels: "nope" }),
      (error) => {
        assert.equal(error.code, "UNKNOWN_ISSUE_LABEL");
        assert.match(error.message, /"nope"/);
        return true;
      },
    );
  });
});

// The existence check costs one extra read. A plan that changes nothing label
// related must not pay for it.
test("a plan with no label change makes no label request", async () => {
  await withLabelFixture([labels(["bug"])], async (root, calls) => {
    const stored = await createIssueUpdatePlan(root, 42, { title: "New title" });
    assert.equal(stored.plan.operation.changes.title, "New title");
    assert.equal(
      calls.some((call) => call.includes("/labels")),
      false,
      "an unrelated update must not read the label list",
    );
  });
});

// The stored name is padded relative to the request. GitLab returns
// label.name verbatim, so the project side needs trimming; the request side
// is already normalized by validateIssueLabelList.
test("a label stored with surrounding spaces still matches an unpadded request", async () => {
  await withLabelFixture([labels(["  bug  "])], async (root) => {
    const stored = await createIssueUpdatePlan(root, 42, { add_labels: "bug" });
    assert.equal(stored.plan.state, "draft");
  });
});
