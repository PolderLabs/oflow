import assert from "node:assert/strict";
import test from "node:test";
import { deriveTransportState } from "../dist/transport.js";

const SOURCES_ENV = [
  {
    host: "gitlab.example.test",
    source: "environment",
    authenticated: true,
    interactive: false,
    backendCompatibility: ["rest", "graphql"],
  },
];

const SOURCES_ENV_MCP = [
  {
    host: "gitlab.example.test",
    source: "environment",
    authenticated: true,
    interactive: false,
    backendCompatibility: ["rest", "graphql"],
  },
  {
    host: "gitlab.example.test",
    source: "mcp-runtime",
    authenticated: "runtime-owned",
    interactive: false,
    backendCompatibility: ["delegated MCP actions"],
  },
];

const SOURCES_NONE = [];

const SOURCES_GLAB = [
  {
    host: "gitlab.example.test",
    source: "glab",
    authenticated: true,
    interactive: false,
    backendCompatibility: ["glab api reads", "glab api mutations"],
  },
];

test("deriveTransportState: env token → configured/true/true/true/true", () => {
  const state = deriveTransportState({
    sources: SOURCES_ENV,
    readBackend: "rest",
    mutationBackend: "rest",
    authenticated: true,
  });
  assert.deepEqual(state, {
    configured: true,
    authenticated: true,
    readable: true,
    mutable: true,
    verifiable: true,
  });
});

test("deriveTransportState: no sources → all false except mutable=unsupported", () => {
  const state = deriveTransportState({
    sources: SOURCES_NONE,
    readBackend: "none",
    mutationBackend: "none",
    authenticated: false,
  });
  assert.deepEqual(state, {
    configured: false,
    authenticated: false,
    readable: false,
    mutable: "unsupported",
    verifiable: "unsupported",
  });
});

test("deriveTransportState: MCP runtime source re-promotes authenticated to runtime-owned", () => {
  const state = deriveTransportState({
    sources: SOURCES_ENV_MCP,
    readBackend: "rest",
    mutationBackend: "gitlab-mcp",
    authenticated: true,
  });
  assert.equal(state.authenticated, "runtime-owned");
  assert.equal(state.mutable, "runtime-owned");
  assert.equal(state.verifiable, "runtime-owned");
  assert.equal(state.readable, true);
  assert.equal(state.configured, true);
});

test("deriveTransportState: glab CLI alone keeps authenticated=true and selectable mutation", () => {
  const state = deriveTransportState({
    sources: SOURCES_GLAB,
    readBackend: "glab",
    mutationBackend: "glab",
    authenticated: true,
  });
  assert.equal(state.configured, true);
  assert.equal(state.authenticated, true);
  assert.equal(state.readable, true);
  assert.equal(state.mutable, true);
  assert.equal(state.verifiable, true);
});

test("deriveTransportState: readBackend=none forces readable=false even when source is configured", () => {
  const state = deriveTransportState({
    sources: SOURCES_ENV,
    readBackend: "none",
    mutationBackend: "rest",
    authenticated: true,
  });
  assert.equal(state.configured, true);
  assert.equal(state.readable, false);
  assert.equal(state.mutable, true);
});

test("deriveTransportState: mutability verdict never silently promotes to true", () => {
  // Heuristic must not yield `mutable: true` when mutationBackend is "none";
  // the doctor contract forbids testing writes. "unsupported" is the only
  // safe downgrade.
  const state = deriveTransportState({
    sources: SOURCES_NONE,
    readBackend: "none",
    mutationBackend: "none",
    authenticated: false,
  });
  assert.notEqual(state.mutable, true);
});
