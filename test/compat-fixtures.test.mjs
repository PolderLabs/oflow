import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "compat");

const REQUIRED_CAPABILITY_KEYS = ["id", "usable", "backend"];
const ISSUE_UPDATE_FIELDS = [
  "title",
  "description",
  "labels",
  "add_labels",
  "remove_labels",
  "milestone",
  "milestone_id",
  "epic_id",
  "issue_type",
  "due_date",
  "weight",
  "assignee_ids",
  "state_event",
];

async function loadFixtures() {
  const names = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith(".json")).sort();
  const fixtures = [];
  for (const name of names) {
    const raw = await readFile(join(FIXTURE_DIR, name), "utf8");
    fixtures.push({ name, data: JSON.parse(raw) });
  }
  return fixtures;
}

test("compat fixtures exist for host and transport boundaries", async () => {
  const fixtures = await loadFixtures();
  const names = fixtures.map((fixture) => fixture.data.name);
  assert.ok(names.includes("direct-token-rest"));
  assert.ok(names.includes("glab-only"));
  assert.ok(names.includes("runtime-mcp-delegated"));
  assert.ok(names.includes("claude-code-host"));
  assert.ok(names.includes("codex-host"));
  assert.ok(names.includes("omp-bridge"));
});

test("compat fixtures never embed credentials or private hosts", async () => {
  const fixtures = await loadFixtures();
  for (const { name, data } of fixtures) {
    const text = JSON.stringify(data);
    assert.equal(/glpat-|ghp_|xox[baprs]-|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY/.test(text), false, name);
    assert.equal(/(?:^|[^.])(?:gmail|outlook|yahoo)\./i.test(text), false, name);
    assert.equal(text.includes("/home/"), false, name);
    assert.equal(text.includes("GITLAB_TOKEN="), false, name);
    assert.ok(!/"(?:token|password|secret|apiKey)"\s*:\s*"[^"]+"/i.test(text) || text.includes("credentials") || text.includes("none-in-fixture"), name);
  }
});

test("transport fixtures advertise the same issue-update field set", async () => {
  const fixtures = await loadFixtures();
  const rest = fixtures.find((fixture) => fixture.data.name === "direct-token-rest");
  const glab = fixtures.find((fixture) => fixture.data.name === "glab-only");
  assert.ok(rest && glab);
  const restFields = rest.data.writes["PUT /api/v4/projects/team%2Fproject/issues/42"].formFields;
  const glabFields = glab.data.writes["glab api PUT projects/team%2Fproject/issues/42"].fields;
  assert.deepEqual(restFields, ISSUE_UPDATE_FIELDS);
  assert.deepEqual(glabFields, ISSUE_UPDATE_FIELDS);
  assert.deepEqual(restFields, glabFields);
});

test("capability entries use the shared usability shape", async () => {
  const fixtures = await loadFixtures();
  for (const { name, data } of fixtures) {
    if (!Array.isArray(data.capabilities)) continue;
    for (const capability of data.capabilities) {
      for (const key of REQUIRED_CAPABILITY_KEYS) {
        assert.ok(key in capability, name + " capability missing " + key);
      }
      if (capability.usable === false) {
        assert.equal(typeof capability.reason, "string", name + " unusable capability needs reason");
      }
      if (capability.usable === true) {
        assert.equal(typeof capability.backend, "string", name + " usable capability needs backend");
      }
    }
  }
});

test("delegated fixture receipt matches apply --receipt contract", async () => {
  const fixtures = await loadFixtures();
  const delegated = fixtures.find((fixture) => fixture.data.name === "runtime-mcp-delegated");
  assert.ok(delegated);
  const action = delegated.data.delegatedAction.action;
  assert.equal(action.name, "merge_request.create");
  assert.equal(typeof action.arguments.project, "string");
  assert.equal(typeof action.arguments.sourceBranch, "string");
  assert.equal(typeof action.arguments.targetBranch, "string");
  assert.equal(typeof action.arguments.title, "string");
  const receipt = delegated.data.receipt;
  assert.equal(receipt.backend, "gitlab-mcp");
  assert.equal(receipt.action, action.name);
  assert.equal(receipt.success, true);
  assert.equal(typeof receipt.executedAt, "string");
  assert.match(delegated.data.delegatedAction.afterExecution.command, /oflow apply .* --receipt/);
});

test("host fixtures document planPath and approval boundaries", async () => {
  const fixtures = await loadFixtures();
  const hostFixtures = fixtures.filter((fixture) =>
    ["claude-code-host", "codex-host", "omp-bridge"].includes(fixture.data.name),
  );
  assert.equal(hostFixtures.length, 3);
  for (const { name, data } of hostFixtures) {
    assert.ok(Array.isArray(data.host.instructionFiles), name);
    assert.ok(data.cliContract && typeof data.cliContract === "object", name);
    const serialized = JSON.stringify(data.boundaries ?? []);
    assert.match(serialized, /planPath|approve|verify|JSON|token/i, name);
  }
});
