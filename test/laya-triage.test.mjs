import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { triageText, describeTriage } from "../dist/laya-triage.js";

// A stub stands in for the real laya binary so the suite never depends on a
// Python environment being present. The one test that exercises the real
// engine is gated on an explicit opt-in.
function stubLaya(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

function stub(dir, name, score, probabilities) {
  const payload = JSON.stringify({
    answers: {
      difficulty: { score, confidence: 0.3 },
      domain: { probabilities },
    },
  });
  return stubLaya(dir, name, "#!/bin/sh\ncat <<'PAYLOAD'\n" + payload + "\nPAYLOAD\n");
}

test("triage reports the raw score and the top domain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stub(dir, "laya", 2.4, { code: 0.9, writing: 0.1 });
    const signal = await triageText("Refactor the verifier dispatch", { executable: bin });
    assert.equal(signal.score, 2.4);
    assert.equal(signal.domain, "code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The published checkpoint disowns its own confidences, so the module must not
// pass them along. A caller that trusted them would gate on a number the
// engine explicitly called uncalibrated.
test("confidence is reported as zero for the uncalibrated checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stub(dir, "laya", 1.5, { code: 1 });
    const signal = await triageText("task", { executable: bin });
    assert.equal(signal.confidence, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the highest-probability domain wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stub(dir, "laya", 1.8, { code: 0.2, writing: 0.7, chitchat: 0.1 });
    const signal = await triageText("task", { executable: bin });
    assert.equal(signal.domain, "writing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-numeric score yields no signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stub(dir, "laya", "high", { code: 1 });
    assert.equal(await triageText("task", { executable: bin }), null);
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

test("an empty input is never probed", async () => {
  // A path that would fail loudly if it were ever invoked.
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
test("the default timeout outlasts a call slower than a real probe", async () => {
  // A real probe costs about 3.7s here, dominated by engine start-up rather
  // than by the input. The default timeout has to clear that with room to
  // spare, or every successful call becomes a silent null -- which reads as
  // "Laya is not installed" and makes the whole feature look dead. This stub
  // deliberately outlasts a 4s ceiling, so it can only return a signal when
  // the declared default is genuinely generous.
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const payload = JSON.stringify({
      answers: {
        difficulty: { score: 1.1, confidence: 0.2 },
        domain: { probabilities: { code: 1 } },
      },
    });
    const slow = stubLaya(dir, "laya-slower",
      "#!/bin/sh\nsleep 5\ncat <<'PAYLOAD'\n" + payload + "\nPAYLOAD\n");
    const signal = await triageText("task", { executable: slow });
    assert.notEqual(signal, null, "default timeout must clear a 5s call");
    assert.equal(signal.domain, "code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The published checkpoint disowns its own confidences, so the module must not
// pass them along. A caller that trusted them would gate on a number the
// engine explicitly called uncalibrated.
test("confidence is reported as zero for the uncalibrated checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stub(dir, "laya", 1.5, { code: 1 });
    const signal = await triageText("task", { executable: bin });
    assert.equal(signal.confidence, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the highest-probability domain wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stub(dir, "laya", 1.8, { code: 0.2, writing: 0.7, chitchat: 0.1 });
    const signal = await triageText("task", { executable: bin });
    assert.equal(signal.domain, "writing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-numeric score yields no signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const bin = stub(dir, "laya", "high", { code: 1 });
    assert.equal(await triageText("task", { executable: bin }), null);
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

test("an empty input is never probed", async () => {
  // A path that would fail loudly if it were ever invoked.
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
test("the default timeout outlasts a call slower than a real probe", async () => {
  // A real probe costs about 3.7s here, dominated by engine start-up rather
  // than by the input. The default timeout has to clear that with room to
  // spare, or every successful call becomes a silent null -- which reads as
  // "Laya is not installed" and makes the whole feature look dead. This stub
  // deliberately outlasts a 4s ceiling, so it can only return a signal when
  // the declared default is genuinely generous.
  const dir = mkdtempSync(join(tmpdir(), "oflow-laya-"));
  try {
    const payload = JSON.stringify({
      answers: {
        difficulty: { score: 1.1, confidence: 0.2 },
        domain: { probabilities: { code: 1 } },
      },
    });
    const slow = stubLaya(dir, "laya-slower",
      "#!/bin/sh\nsleep 5\ncat <<'PAYLOAD'\n" + payload + "\nPAYLOAD\n");
    const signal = await triageText("task", { executable: slow });
    assert.notEqual(signal, null, "default timeout must clear a 5s call");
    assert.equal(signal.domain, "code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("describeTriage names the domain and stays silent when it is unknown", () => {
  assert.equal(
    describeTriage({ score: 2.1, confidence: 0, domain: "code" }),
    "looks like a code task",
  );
  assert.equal(describeTriage({ score: 2.1, confidence: 0, domain: "unknown" }), null);
  assert.equal(describeTriage(null), null);
});

// Opt-in only: the sole test that needs the real Python engine, so a normal
// `npm test` on a machine without it stays green.
test("the real laya engine produces a signal on this host", { skip: !process.env.OFLOW_LAYA_E2E }, async () => {
  const signal = await triageText("Refactor the apply path into modules");
  assert.notEqual(signal, null);
  assert.ok(signal.score > 0);
});
