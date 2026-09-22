import assert from "node:assert/strict";
import test from "node:test";
import { formatCapabilitiesMarkdown } from "../dist/capabilities.js";

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
