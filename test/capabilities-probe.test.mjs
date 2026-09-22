import assert from "node:assert/strict";
import test from "node:test";
import { probeCapabilities } from "../dist/auth-resolver.js";

const SOURCES_ENV = [{
  host: "gitlab.example.test",
  source: "environment",
  authenticated: true,
  interactive: false,
  backendCompatibility: ["rest"],
  notes: [],
}];

const SOURCES_NONE = [];

const SOURCES_MCP = [{
  host: "gitlab.example.test",
  source: "mcp-runtime",
  authenticated: "runtime-owned",
  interactive: false,
  backendCompatibility: ["delegated MCP actions"],
  notes: [],
}];

function makeStubClient(responses) {
  return class StubClient {
    constructor(host) {
      this.host = host;
      this.calls = [];
    }
    async getCurrentUser() {
      this.calls.push(["getCurrentUser"]);
      return responses.getCurrentUser;
    }
    async getProject(projectPath) {
      this.calls.push(["getProject", projectPath]);
      return responses.getProject;
    }
    async listIssuesPage(projectPath, state, limit) {
      this.calls.push(["listIssuesPage", projectPath, state, limit]);
      return responses.listIssuesPage;
    }
    async listMergeRequestsPage(projectPath, storyIid, state, limit) {
      this.calls.push(["listMergeRequestsPage", projectPath, storyIid, state, limit]);
      return responses.listMergeRequestsPage;
    }
    async listPipelinesPage(projectPath, ref, limit) {
      this.calls.push(["listPipelinesPage", projectPath, ref, limit]);
      return responses.listPipelinesPage;
    }
    async listLabelsPage(projectPath, limit) {
      this.calls.push(["listLabelsPage", projectPath, limit]);
      return responses.listLabelsPage;
    }
    async listMilestonesPage(projectPath, state, limit) {
      this.calls.push(["listMilestonesPage", projectPath, state, limit]);
      return responses.listMilestonesPage;
    }
    async listBoardsPage(projectPath, limit) {
      this.calls.push(["listBoardsPage", projectPath, limit]);
      return responses.listBoardsPage;
    }
  };
}

test("probeCapabilities marks every read capability as passed when probes succeed", async () => {
  const StubClient = makeStubClient({
    getCurrentUser: { id: 1, username: "me" },
    getProject: { id: 1, path_with_namespace: "team/project" },
    listIssuesPage: { items: [], pageInfo: { next: null } },
    listMergeRequestsPage: { items: [], pageInfo: { next: null } },
    listPipelinesPage: { items: [], pageInfo: { next: null } },
    listLabelsPage: { items: [], pageInfo: { next: null } },
    listMilestonesPage: { items: [], pageInfo: { next: null } },
    listBoardsPage: { items: [], pageInfo: { next: null } },
  });
  const caps = await probeCapabilities(
    {
      host: "gitlab.example.test",
      projectPath: "team/project",
      clientFactory: (host) => new StubClient(host),
      perProbeTimeoutMs: 1000,
    },
    SOURCES_ENV,
    "rest",
  );
  const reads = caps.filter((c) => c.id === "user.read" || c.id === "project.read" || c.id === "work-items.read");
  for (const cap of reads) {
    assert.equal(cap.usable, true, cap.id + " should be usable");
    assert.equal(cap.probe, "passed", cap.id + " probe should be passed");
    assert.equal(cap.source, "environment");
    assert.equal(cap.backend, "rest");
    assert.ok(cap.reason && cap.reason.length > 0, cap.id + " reason must be present");
  }
});

test("probeCapabilities marks non-MCP write capabilities as not-probed and labels them clearly", async () => {
  const StubClient = makeStubClient({});
  const caps = await probeCapabilities(
    {
      host: "gitlab.example.test",
      projectPath: "team/project",
      clientFactory: (host) => new StubClient(host),
      perProbeTimeoutMs: 1000,
    },
    SOURCES_ENV,
    "rest",
  );
  const writes = caps.filter((c) => c.access === "write" || ["work-items.update", "notes.write", "labels.write", "milestones.write", "boards.write", "iteration-assignment.write"].includes(c.id));
  for (const cap of writes) {
    assert.equal(cap.usable, false, cap.id + " should be unusable without MCP runtime");
    assert.equal(cap.probe, "not-probed");
    assert.ok(/apply/i.test(cap.reason ?? ""), cap.id + " reason must explain write is verified via apply");
  }
});

test("probeCapabilities marks writes usable:true backend:gitlab-mcp when mcp-runtime source is present", async () => {
  const StubClient = makeStubClient({});
  const caps = await probeCapabilities(
    {
      host: "gitlab.example.test",
      projectPath: "team/project",
      clientFactory: (host) => new StubClient(host),
      perProbeTimeoutMs: 1000,
    },
    SOURCES_MCP,
    "none",
  );
  const writes = caps.filter((c) => [
    "work-items.update", "notes.write", "labels.write", "milestones.write",
    "boards.write", "iteration-assignment.write", "merge-requests.write",
  ].includes(c.id));
  assert.ok(writes.length >= 7, "expected the full write capability set");
  for (const cap of writes) {
    assert.equal(cap.usable, true, cap.id + " should be usable via MCP");
    assert.equal(cap.backend, "gitlab-mcp", cap.id + " backend should be gitlab-mcp");
    assert.equal(cap.source, "mcp-runtime");
    assert.equal(cap.probe, "not-probed");
  }
});

test("probeCapabilities converts numeric 403 from GitLabApiError into probe forbidden + remediation", async () => {
  class ForbiddenClient {
    constructor(host) { this.host = host; }
    async getCurrentUser() {
      const error = new Error("GitLab API 403 for /user");
      error.status = 403;
      throw error;
    }
    async getProject() { throw Object.assign(new Error("forbidden"), { status: 403 }); }
    async listIssuesPage() { return { items: [] }; }
    async listMergeRequestsPage() { return { items: [] }; }
    async listPipelinesPage() { return { items: [] }; }
    async listLabelsPage() { return { items: [] }; }
    async listMilestonesPage() { return { items: [] }; }
    async listBoardsPage() { return { items: [] }; }
  }
  const caps = await probeCapabilities(
    {
      host: "gitlab.example.test",
      projectPath: "team/project",
      clientFactory: (host) => new ForbiddenClient(host),
      perProbeTimeoutMs: 1000,
    },
    SOURCES_ENV,
    "rest",
  );
  const user = caps.find((c) => c.id === "user.read");
  assert.equal(user.probe, "forbidden");
  assert.equal(user.usable, false);
  assert.ok(/HTTP 403/.test(user.reason));
  assert.ok(user.remediation && /token with broader scopes/.test(user.remediation));
  const project = caps.find((c) => c.id === "project.read");
  assert.equal(project.probe, "forbidden");
});

test("probeCapabilities normalises 401 to forbidden with re-auth remediation", async () => {
  class UnauthorizedClient {
    constructor(host) { this.host = host; }
    async getCurrentUser() {
      const error = new Error("GitLab API 401 Unauthorized");
      error.status = 401;
      throw error;
    }
    async getProject() { return { id: 1, path_with_namespace: "team/project" }; }
    async listIssuesPage() { return { items: [] }; }
    async listMergeRequestsPage() { return { items: [] }; }
    async listPipelinesPage() { return { items: [] }; }
    async listLabelsPage() { return { items: [] }; }
    async listMilestonesPage() { return { items: [] }; }
    async listBoardsPage() { return { items: [] }; }
  }
  const caps = await probeCapabilities(
    {
      host: "gitlab.example.test",
      projectPath: "team/project",
      clientFactory: (host) => new UnauthorizedClient(host),
      perProbeTimeoutMs: 1000,
    },
    SOURCES_ENV,
    "rest",
  );
  const user = caps.find((c) => c.id === "user.read");
  assert.equal(user.probe, "forbidden");
  assert.ok(/oflow auth login/.test(user.remediation ?? ""));
});

test("probeCapabilities skips project-scoped reads when readBackend is none", async () => {
  const caps = await probeCapabilities(
    { host: "gitlab.example.test", projectPath: "team/project" },
    SOURCES_NONE,
    "none",
  );
  for (const id of ["project.read", "work-items.read", "labels.read"]) {
    const cap = caps.find((c) => c.id === id);
    assert.equal(cap.probe, "skipped");
    assert.equal(cap.usable, false);
    assert.ok(/no authenticated read transport/.test(cap.reason ?? ""));
  }
});

test("probeCapabilities labels reads as skipped when projectPath is missing", async () => {
  const caps = await probeCapabilities(
    { host: "gitlab.example.test" },
    SOURCES_ENV,
    "rest",
  );
  const project = caps.find((c) => c.id === "project.read");
  assert.equal(project.probe, "skipped");
  assert.ok(/project path not yet resolved/.test(project.reason ?? ""));
});

test("probeCapabilities enforces a per-probe timeout", async () => {
  class SlowClient {
    constructor(host) { this.host = host; }
    async getCurrentUser() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { id: 1, username: "me" };
    }
    async getProject() { return { id: 1, path_with_namespace: "team/project" }; }
    async listIssuesPage() { return { items: [] }; }
    async listMergeRequestsPage() { return { items: [] }; }
    async listPipelinesPage() { return { items: [] }; }
    async listLabelsPage() { return { items: [] }; }
    async listMilestonesPage() { return { items: [] }; }
    async listBoardsPage() { return { items: [] }; }
  }
  const caps = await probeCapabilities(
    {
      host: "gitlab.example.test",
      projectPath: "team/project",
      clientFactory: (host) => new SlowClient(host),
      perProbeTimeoutMs: 5,
    },
    SOURCES_ENV,
    "rest",
  );
  const user = caps.find((c) => c.id === "user.read");
  assert.equal(user.usable, false);
  assert.ok(/timed out/i.test(user.reason ?? ""));
});


test("normalizeForbidden returns remediation for 403 with oflow workarounds named", async () => {
  const { normalizeForbidden } = await import("../dist/auth-resolver.js");
  const error = Object.assign(new Error("GitLab API 403 for /user"), { status: 403 });
  const out = normalizeForbidden(error);
  assert.equal(out.probe, "forbidden");
  assert.ok(/HTTP 403/.test(out.reason));
  assert.ok(/oflow mr create --delegate/.test(out.remediation ?? ""));
  assert.ok(/git push -o merge_request.create/.test(out.remediation ?? ""));
});

test("normalizeForbidden returns remediation for 401 with re-auth hint", async () => {
  const { normalizeForbidden } = await import("../dist/auth-resolver.js");
  const error = Object.assign(new Error("GitLab API 401 Unauthorized"), { status: 401 });
  const out = normalizeForbidden(error);
  assert.equal(out.probe, "forbidden");
  assert.ok(/oflow auth login/.test(out.remediation ?? ""));
});
