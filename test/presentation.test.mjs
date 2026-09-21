import assert from "node:assert/strict";
import test from "node:test";
import { dim, resolvePresentation, statusMarker } from "../dist/presentation.js";
import { formatDoctor } from "../dist/doctor.js";
import { formatFinishMarkdown } from "../dist/lifecycle.js";

const COLOR = { color: true };
const PLAIN = { color: false };

function withEnv(name, value, run) {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

test("resolvePresentation enables color only on a TTY without NO_COLOR", async () => {
  await withEnv("NO_COLOR", undefined, () => {
    assert.deepEqual(resolvePresentation({ isTTY: true }), { color: true });
    assert.deepEqual(resolvePresentation({ isTTY: false }), { color: false });
    assert.deepEqual(resolvePresentation({}), { color: false });
  });
});

test("resolvePresentation honors NO_COLOR set to any non-empty value", async () => {
  await withEnv("NO_COLOR", "1", () => {
    assert.deepEqual(resolvePresentation({ isTTY: true }), { color: false });
  });
});

test("resolvePresentation treats empty NO_COLOR as unset", async () => {
  await withEnv("NO_COLOR", "", () => {
    assert.deepEqual(resolvePresentation({ isTTY: true }), { color: true });
    assert.deepEqual(resolvePresentation({ isTTY: false }), { color: false });
  });
});

test("statusMarker wraps known statuses in color only when enabled", () => {
  const pass = statusMarker("PASS", COLOR);
  assert.ok(pass.includes("\u001b[32m"));
  assert.ok(pass.includes("\u001b[39m"));
  assert.ok(pass.startsWith("\u001b[32mPASS\u001b[39m"));

  const fail = statusMarker("FAIL", PLAIN);
  assert.equal(fail, "FAIL");

  const ready = statusMarker("NOT READY", COLOR);
  assert.ok(ready.startsWith("\u001b[31mNOT READY\u001b[39m"));

  const skip = statusMarker("SKIP", COLOR);
  assert.ok(skip.startsWith("\u001b[33mSKIP\u001b[39m"));

  assert.equal(statusMarker("passed", COLOR), "\u001b[32mpassed\u001b[39m");
  assert.equal(statusMarker("failed", COLOR), "\u001b[31mfailed\u001b[39m");
  assert.equal(statusMarker("skipped", COLOR), "\u001b[33mskipped\u001b[39m");
  assert.equal(statusMarker("READY", COLOR), "\u001b[32mREADY\u001b[39m");
});

test("statusMarker leaves unknown statuses plain even with color on", () => {
  assert.equal(statusMarker("MAYBE", COLOR), "MAYBE");
  assert.equal(statusMarker("", COLOR), "");
  assert.equal(statusMarker("pass", PLAIN), "pass");
});

test("dim wraps text only when color is enabled", () => {
  assert.equal(dim("  (120ms)", COLOR), "\u001b[2m  (120ms)\u001b[22m");
  assert.equal(dim("  (120ms)", PLAIN), "  (120ms)");
  assert.equal(dim("# oflow doctor", COLOR), "\u001b[2m# oflow doctor\u001b[22m");
  assert.equal(dim("# oflow doctor", PLAIN), "# oflow doctor");
});

const report = {
  root: "/tmp/repo",
  remote: { host: "gitlab.com", projectPath: "team/product", remoteUrl: "git@gitlab.com:team/product.git" },
  configFound: true,
  agent: { mode: "single", claude: false, codex: false },
  tokenConfigured: true,
  tokenSource: "environment",
  apiCheck: "passed",
  apiChecks: [
    {
      id: "projects:get",
      access: "read",
      backend: "REST",
      status: "passed",
      required: true,
      detail: "200 OK",
      latencyMs: 123,
    },
    {
      id: "issues:create",
      access: "write",
      backend: "REST",
      status: "skipped",
      required: true,
      detail: "doctor never tests a mutation",
    },
  ],
  backends: {
    rest: { available: true, role: "core" },
    glab: { available: false, version: null, role: "optional-fallback" },
    mcp: { available: false, role: "agent-runtime", note: "agent runtime" },
  },
  requiredFiles: [{ path: "README.md", present: true }],
  warnings: [],
};

test("formatDoctor with color:false is byte-identical to the default call", () => {
  assert.equal(formatDoctor(report, PLAIN), formatDoctor(report));
});

test("formatDoctor plain output contains no ANSI escape bytes", () => {
  const plain = formatDoctor(report, PLAIN);
  assert.ok(!plain.includes("\u001b["));
  assert.ok(plain.includes("- [PASS] REST projects:get (123ms) — 200 OK"));
  assert.ok(plain.includes("- [SKIP] REST issues:create — doctor never tests a mutation"));
});

test("formatDoctor with color wraps markers, latency, and header", () => {
  const colored = formatDoctor(report, COLOR);
  assert.ok(colored.startsWith("\u001b[2m# oflow doctor\u001b[22m\n"));
  assert.ok(colored.includes("\u001b[32mPASS\u001b[39m"));
  assert.ok(colored.includes("\u001b[33mSKIP\u001b[39m"));
  assert.ok(colored.includes("\u001b[2m (123ms)\u001b[22m"));
});

const finishResult = {
  story: 42,
  ready: false,
  gates: [{ id: "tests-pass", passed: true, detail: "93/93 green" }],
  nextCommand: "oflow plan close !42",
  warnings: [],
};

test("formatFinishMarkdown default output is unchanged and plain", () => {
  const plain = formatFinishMarkdown(finishResult);
  assert.equal(plain, formatFinishMarkdown(finishResult, PLAIN));
  assert.ok(!plain.includes("\u001b["));
  assert.ok(plain.includes("Story !42 — NOT READY"));
  assert.ok(plain.includes("- [PASS] tests-pass — 93/93 green"));
});

test("formatFinishMarkdown with color wraps gates and readiness", () => {
  const colored = formatFinishMarkdown(finishResult, COLOR);
  assert.ok(colored.includes("\u001b[31mNOT READY\u001b[39m"));
  assert.ok(colored.includes("\u001b[32mPASS\u001b[39m"));
  assert.ok(colored.startsWith("\u001b[2m# oflow finish\u001b[22m\n"));
});
