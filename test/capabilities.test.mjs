import assert from "node:assert/strict";
import test from "node:test";
import { buildPerCapabilityState, formatCapabilitiesMarkdown, getCapabilities } from "../dist/capabilities.js";

function stubResult(capabilities) {
  return {
    generatedAt: "2026-09-22T00:00:00.000Z",
    backends: {
      rest: { available: true },
      glab: { available: false, version: null },
      mcp: { available: false, role: "agent-runtime" },
    },
    capabilities,
  };
}

test("capabilities markdown keeps the MCP header line and blank separator before the table", () => {
  const text = formatCapabilitiesMarkdown(stubResult([]));
  assert.match(text, /^MCP: agent-runtime optional$/m);
  const mcpIndex = text.indexOf("MCP: agent-runtime optional");
  const headerIndex = text.indexOf("| Capability | State | Access | Resource | Backend | Permission | Note |");
  assert.ok(mcpIndex >= 0 && headerIndex > mcpIndex);
  assert.ok(text.slice(mcpIndex, headerIndex).includes("\n\n"));
});

test("capabilities markdown renders note cells for noted and plain rows", () => {
  const text = formatCapabilitiesMarkdown(stubResult([
    {
      id: "work-items.read",
      state: "implemented",
      access: "read",
      resource: "Work Item",
      backend: "REST",
      permission: "Work Item: Read",
      note: "Covers issue and task types only",
    },
    {
      id: "project.read",
      state: "implemented",
      access: "read",
      resource: "Project",
      backend: "REST",
      permission: "Project: Read",
    },
  ]));
  assert.match(text, /\| work-items\.read \| implemented \| read \| Work Item \| REST \| Work Item: Read \| Covers issue and task types only \|/);
  assert.match(text, /\| project\.read \| implemented \| read \| Project \| REST \| Project: Read \|  \|/);
});

test("every catalog capability is registered for a per-capability usability state", async () => {
  // A capability can render in `oflow capabilities` and still be invisible to
  // the state builder, which skips ids it has no internal definition for. The
  // result is a row that can never be marked usable or blocked.
  const { capabilities } = await getCapabilities();
  const ids = capabilities.map((entry) => entry.id).sort();
  const state = buildPerCapabilityState(
    { mutable: "unsupported", verifiable: "unsupported" },
    ids,
  );
  const missing = ids.filter((id) => !(id in state));
  assert.deepEqual(missing, [], "capabilities with no usability state: " + missing.join(", "));
});

test("pipeline job readability is a registered capability", async () => {
  const { capabilities } = await getCapabilities();
  const entry = capabilities.find((item) => item.id === "pipelines.jobs.read");
  assert.ok(entry, "pipelines.jobs.read must appear in the catalog");
  assert.equal(entry.access, "read");
  assert.equal(entry.state, "implemented");
  assert.match(entry.permission, /Pipeline: Read/);
});
