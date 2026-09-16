import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import {
  formatIterationListMarkdown,
  listIterations,
} from "../dist/iterations.js";

const run = promisify(execFile);

test("lists project-visible iterations compactly and can read the parent group", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-iterations-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "iteration-test-token";
  const requests = [];
  try {
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "git@gitlab.example.test:team/project.git"]);
    await mkdir(join(root, ".oflow"), { recursive: true });
    await writeFile(join(root, ".oflow", "config.json"), JSON.stringify({
      managedBy: "oflow",
      version: 1,
      project: { host: "gitlab.example.test", path: "team/project" },
    }));

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      let response;
      if (url.pathname === "/api/v4/projects/team%2Fproject") {
        response = {
          id: 7,
          path_with_namespace: "team/project",
          namespace: { full_path: "team" },
        };
      } else if (url.pathname === "/api/v4/projects/team%2Fproject/iterations") {
        response = [{
          id: 53,
          iid: 13,
          title: "Iteration II",
          description: "Do not include this in compact output",
          state: "current",
          start_date: "2026-09-14",
          due_date: "2026-09-27",
          web_url: "https://gitlab.example.test/team/project/-/iterations/13",
        }];
      } else if (url.pathname === "/api/v4/groups/team/iterations") {
        response = [{
          id: 54,
          iid: 14,
          title: "Iteration III",
          state: "upcoming",
          start_date: "2026-09-28",
          due_date: "2026-10-11",
        }];
      } else {
        throw new Error("unexpected request " + url.pathname);
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(response),
      };
    };

    const projectResult = await listIterations(root, "current", 2);
    assert.equal(projectResult.scope, "project");
    assert.equal(projectResult.groupPath, null);
    assert.deepEqual(projectResult.iterations, [{
      iid: 13,
      title: "Iteration II",
      state: "current",
      startDate: "2026-09-14",
      dueDate: "2026-09-27",
      webUrl: "https://gitlab.example.test/team/project/-/iterations/13",
    }]);
    assert.equal(requests[0].searchParams.get("state"), "current");
    assert.equal(requests[0].searchParams.get("per_page"), "2");
    assert.equal(requests[0].searchParams.get("include_ancestors"), "true");
    assert.doesNotMatch(formatIterationListMarkdown(projectResult), /description/);

    const groupResult = await listIterations(root, "upcoming", 3, "group");
    assert.equal(groupResult.groupPath, "team");
    assert.equal(groupResult.iterations[0].title, "Iteration III");
    const groupRequest = requests.at(-1);
    assert.equal(groupRequest.pathname, "/api/v4/groups/team/iterations");
    assert.equal(groupRequest.searchParams.get("state"), "upcoming");
    assert.equal(groupRequest.searchParams.get("include_ancestors"), "true");

    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v4/projects/team%2Fproject") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({
            id: 7,
            path_with_namespace: "team/project",
            namespace: { full_path: "team" },
          }),
        };
      }
      return {
        ok: false,
        status: 404,
        headers: new Headers(),
        text: async () => JSON.stringify({ message: "404 Not Found" }),
      };
    };
    await assert.rejects(
      () => listIterations(root, "current", 1, "group"),
      {
        code: "GITLAB_GROUP_UNAVAILABLE",
        message: /Could not read parent-group iterations.*Group: Read access/,
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
