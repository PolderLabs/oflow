import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import {
  formatIterationCadenceMarkdown,
  listIterationCadences,
} from "../dist/cadences.js";

const run = promisify(execFile);

test("lists group iteration cadences compactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-cadences-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "cadence-test-token";
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
      if (url.pathname === "/api/v4/projects/team%2Fproject") {
        return response({
          id: 7,
          path_with_namespace: "team/project",
          namespace: { full_path: "team" },
        });
      }
      assert.equal(url.pathname, "/api/graphql");
      return response({
        data: {
          group: {
            iterationCadences: {
              nodes: [{
                id: "gid://gitlab/Iterations::Cadence/1",
                title: "Two-week sprints",
                active: true,
                automatic: true,
                durationInWeeks: 2,
                iterationsInAdvance: 2,
                rollOver: false,
                startDate: "2026-09-14T00:00:00Z",
              }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      });
    };

    const result = await listIterationCadences(root, 20);
    assert.equal(result.groupPath, "team");
    assert.deepEqual(result.cadences, [{
      id: "gid://gitlab/Iterations::Cadence/1",
      title: "Two-week sprints",
      active: true,
      automatic: true,
      durationInWeeks: 2,
      iterationsInAdvance: 2,
      rollOver: false,
      startDate: "2026-09-14T00:00:00Z",
    }]);
    assert.match(formatIterationCadenceMarkdown(result), /Two-week sprints \(active; 2 weeks, automatic; rollover off\)/);
    assert.doesNotMatch(formatIterationCadenceMarkdown(result), /startDate/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

function response(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}
