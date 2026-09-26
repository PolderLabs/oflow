import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { createIssueUpdatePlan, createIssueCreatePlan } from "../dist/plan.js";

const run = promisify(execFile);

// --assignee resolves a name through the GitLab users API, which a
// granular-scope token cannot reach. These tests pin that the failure is an
// oflow-level message naming the cause and the fix, rather than the raw API
// response a user cannot act on.
async function withAssigneeFixture(usersResponse, run_) {
  const root = await mkdtemp(join(tmpdir(), "oflow-assignee-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "assignee-scope-test-token";
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
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/users")) return usersResponse();
      if (url.endsWith("/issues/42")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({
            iid: 42,
            title: "Choose a pod",
            description: "d",
            state: "opened",
            labels: [],
            assignees: [],
            updated_at: "2026-01-01T00:00:00Z",
          }),
        };
      }
      // createIssueCreatePlan reads the project before it resolves the
      // assignee, so the fixture has to answer that lookup too.
      if (url.includes("/projects/") && !url.includes("/issues")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({
            id: 7,
            path_with_namespace: "team/project",
            web_url: "https://gitlab.example.test/team/project",
          }),
        };
      }
      if (method === "POST" && url.endsWith("/issues")) {
        return {
          ok: true,
          status: 201,
          headers: new Headers(),
          text: async () => JSON.stringify({ iid: 77, title: "New", web_url: "https://gitlab.example.test/x" }),
        };
      }
      throw new Error("unstubbed " + method + " " + url);
    };
    return await run_(root);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
}

function forbidden() {
  return () => ({
    ok: false,
    status: 403,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify({
      message: "403 Forbidden",
      error_description:
        "Your token does not have the required scope to perform this action. Required scope: read_user or api",
    }),
  });
}

test("a forbidden assignee lookup reports the cause and a way forward", async () => {
  await withAssigneeFixture(forbidden(), async (root) => {
    await assert.rejects(
      () => createIssueUpdatePlan(root, 42, { title: "t" }, "alice"),
      (error) => {
        assert.equal(error.code, "ASSIGNEE_LOOKUP_FORBIDDEN");
        // The cause has to be legible without knowing GitLab scope names.
        assert.match(error.message, /read_user or api scope/);
        assert.match(error.message, /oflow auth login/);
        // And the user must be able to tell which name failed.
        assert.match(error.message, /"alice"/);
        return true;
      },
    );
    assert.equal(existsSync(join(root, ".oflow", "state", "plans")), false);
  });
});

// The raw body is what made the original failure useless: a JSON blob with no
// indication of which flag produced it.
test("a forbidden assignee lookup does not surface the raw API body", async () => {
  await withAssigneeFixture(forbidden(), async (root) => {
    await assert.rejects(
      () => createIssueUpdatePlan(root, 42, { title: "t" }, "alice"),
      (error) => {
        assert.doesNotMatch(error.message, /error_description/);
        assert.doesNotMatch(error.message, /\{"message"/);
        return true;
      },
    );
  });
});

// The remediation baked into the shared 403 normalizer is written for
// merge-request writes. Suggesting `mr create --delegate` to someone setting
// an issue assignee would send them down the wrong path.
test("a forbidden assignee lookup does not suggest merge-request remediation", async () => {
  await withAssigneeFixture(forbidden(), async (root) => {
    await assert.rejects(
      () => createIssueUpdatePlan(root, 42, { title: "t" }, "alice"),
      (error) => {
        assert.doesNotMatch(error.message, /merge_request\.create/);
        assert.doesNotMatch(error.message, /--delegate/);
        return true;
      },
    );
  });
});

test("an unauthorized assignee lookup is reported the same way", async () => {
  await withAssigneeFixture(
    () => ({
      ok: false,
      status: 401,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ message: "401 Unauthorized" }),
    }),
    async (root) => {
      await assert.rejects(
        () => createIssueUpdatePlan(root, 42, { title: "t" }, "alice"),
        (error) => {
          assert.equal(error.code, "ASSIGNEE_LOOKUP_FORBIDDEN");
          return true;
        },
      );
    },
  );
});

// A network or server failure is not a permissions problem, so it must keep
// its own error rather than being relabelled as one.
test("a non-permission failure is not relabelled as forbidden", async () => {
  await withAssigneeFixture(
    () => ({
      ok: false,
      status: 500,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ message: "500 Internal Server Error" }),
    }),
    async (root) => {
      await assert.rejects(
        () => createIssueUpdatePlan(root, 42, { title: "t" }, "alice"),
        (error) => {
          assert.notEqual(error.code, "ASSIGNEE_LOOKUP_FORBIDDEN");
          return true;
        },
      );
    },
  );
});

test("a successful lookup is unaffected", async () => {
  await withAssigneeFixture(
    () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify([{ id: 6, username: "alice", name: "Alice" }]),
    }),
    async (root) => {
      const stored = await createIssueUpdatePlan(root, 42, { title: "t" }, "alice");
      assert.deepEqual(stored.plan.operation.changes.assignee_ids, [6]);
    },
  );
});

// createIssueCreatePlan shares the same helper, so it must get the same
// treatment rather than leaking the raw body on a different command.
test("issue create reports the same way as issue update", async () => {
  await withAssigneeFixture(forbidden(), async (root) => {
    await assert.rejects(
      () => createIssueCreatePlan(root, { title: "New" }, "alice"),
      (error) => {
        assert.equal(error.code, "ASSIGNEE_LOOKUP_FORBIDDEN");
        assert.match(error.message, /read_user or api scope/);
        return true;
      },
    );
  });
});

// The shared normalizer's scope advice is generic and correct here: a wider
// token really is the only way to resolve a username.
test("a forbidden assignee lookup offers the generic scope remedy", async () => {
  await withAssigneeFixture(forbidden(), async (root) => {
    await assert.rejects(
      () => createIssueUpdatePlan(root, 42, { title: "t" }, "alice"),
      (error) => {
        assert.match(error.message, /broader scopes/);
        assert.match(error.message, /glab auth login/);
        return true;
      },
    );
  });
});

// There is no --assignee-id flag, so the message must not send a user looking
// for an escape hatch that does not exist.
test("a forbidden assignee lookup does not promise a numeric-id flag", async () => {
  await withAssigneeFixture(forbidden(), async (root) => {
    await assert.rejects(
      () => createIssueUpdatePlan(root, 42, { title: "t" }, "alice"),
      (error) => {
        assert.doesNotMatch(error.message, /--assignee-id/);
        assert.doesNotMatch(error.message, /numeric id/);
        return true;
      },
    );
  });
});

// Only 401/403 take the new path. A 404 must keep whatever behaviour it had,
// so a permissions message never masks "this endpoint is gone".
test("a 404 is not reported as a permissions problem", async () => {
  await withAssigneeFixture(
    () => ({
      ok: false,
      status: 404,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ message: "404 Not Found" }),
    }),
    async (root) => {
      await assert.rejects(
        () => createIssueUpdatePlan(root, 42, { title: "t" }, "alice"),
        (error) => {
          // Not merely "not the forbidden code": a dropped rethrow would leave
          // `matches` unassigned and raise a ReferenceError, which is a bug, not
          // the original error surfacing unchanged.
          assert.notEqual(error.code, "ASSIGNEE_LOOKUP_FORBIDDEN");
          assert.notEqual(error.name, "ReferenceError");
          assert.match(error.message, /404/);
          return true;
        },
      );
    },
  );
});
