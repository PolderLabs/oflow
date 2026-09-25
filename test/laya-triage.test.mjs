import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { triageText, describeTriage } from "../dist/laya-triage.js";

// A stub stands in for the real laya binary so the suite never depends on a
// Python environment being present. The one test that exercises the real
// engine is guarded by an explicit opt-in.
function stubLaya(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

function payload(score, probabilities) {
  return JSON.stringify({
    answers: {
      difficulty: { score, confidence: 0.3 },
      domain: { probabilities },
    },
  });
}

test("triage returns a band derived from the raw score", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stubLaya(dir, "laya", "#!/bin/sh\ncat <<'EOF'\n" +
      payload(2.4, { code: 0.9 }) + "\nEOF\n");
    const signal = await triageText("Refactor the verifier dispatch", { executable: bin });
    assert.equal(signal.score, 2.4);
    assert.equal(signal.band, "moderate");
    assert.equal(signal.domain, "code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each band boundary maps to the documented legend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  const cases = [
    [0.2, "trivial"],
    [1.0, "easy"],
    [2.0, "moderate"],
    [3.0, "hard"],
  ];
  try {
    for (const [score, band] of cases) {
      const bin = stubLaya(dir, "laya-" + String(score).replace(".", "_"),
        "#!/bin/sh\ncat <<'EOF'\n" + payload(score, { code: 1 }) + "\nEOF\n");
      const signal = await triageText("task", { executable: bin });
      assert.equal(signal.band, band, "score " + score);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a score on a band edge is reported as uncertain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    // 1.5 is exactly the easy/moderate boundary, so the band is meaningless.
    const bin = stubLaya(dir, "laya", "#!/bin/sh\ncat <<'EOF'\n" +
      payload(1.5, { code: 1 }) + "\nEOF\n");
    const signal = await triageText("task", { executable: bin });
    assert.equal(signal.uncertain, true);
    assert.equal(describeTriage(signal), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the highest-probability domain wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stubLaya(dir, "laya", "#!/bin/sh\ncat <<'EOF'\n" +
      payload(1.8, { code: 0.2, writing: 0.7, chitchat: 0.1 }) + "\nEOF\n");
    const signal = await triageText("task", { executable: bin });
    assert.equal(signal.domain, "writing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The load-bearing cases: triage is advisory, so every failure mode must
// degrade to "no signal" rather than propagating an error to the caller.
test("a missing binary yields no signal instead of an error", async () => {
  const signal = await triageText("anything", {
    executable: join(tmpdir(), "oflow-no-such-laya-binary"),
  });
  assert.equal(signal, null);
});

test("unparseable output yields no signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stubLaya(dir, "laya", "#!/bin/sh\necho 'not json at all'\n");
    assert.equal(await triageText("task", { executable: bin }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nonzero exit yields no signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stubLaya(dir, "laya", "#!/bin/sh\nexit 3\n");
    assert.equal(await triageText("task", { executable: bin }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output without a numeric score yields no signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stubLaya(dir, "laya", "#!/bin/sh\ncat <<'EOF'\n" +
      JSON.stringify({ answers: { difficulty: { score: "high" } } }) + "\nEOF\n");
    assert.equal(await triageText("task", { executable: bin }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty input is never probed", async () => {
  // A binary that would fail loudly if it were ever invoked.
  assert.equal(await triageText("   ", { executable: "/definitely/not/here" }), null);
});

test("a slow binary is abandoned at the timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stubLaya(dir, "laya", "#!/bin/sh\nsleep 5\n");
    const started = Date.now();
    const signal = await triageText("task", { executable: bin, timeoutMs: 150 });
    assert.equal(signal, null);
    assert.ok(Date.now() - started < 4000, "must not wait for the full sleep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("describeTriage names the band when the signal is decisive", () => {
  assert.equal(
    describeTriage({ score: 2.1, confidence: 0, band: "moderate", domain: "code", uncertain: false }),
    "estimated moderate (2.10)",
  );
  assert.equal(describeTriage(null), null);
});

// Opt-in only: this is the sole test that needs the real Python engine, so a
// normal `npm test` on a machine without it stays green.
test("the real laya engine produces a signal on this host", { skip: !process.env.OFLOW_LAYA_E2E }, async () => {
  const signal = await triageText("Refactor the apply path into modules");
  assert.notEqual(signal, null);
  assert.ok(signal.score > 0);
  assert.equal(describeTriage(signal) !== null || signal.uncertain, true);
});
