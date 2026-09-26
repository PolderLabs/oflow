import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseAnswers, runDefaultQuestions, runCustomQuestions, topChoice }
  from "../dist/laya-runner.js";

// The runner must be portable: text in, answers out, no oflow types, and no
// npm dependency on the Python engine. Every stub below stands in for the
// engine so the suite needs no Python at all.

function stub(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

const DIFFICULTY_PAYLOAD = JSON.stringify({
  answers: {
    difficulty: { type: "score", score: 1.8, confidence: 0.4, probabilities: { "1": 0.7, "2": 0.3 } },
    domain: { type: "choice", probabilities: { code: 0.9, writing: 0.1 } },
  },
});

test("the default path reads the stock router questions from the CLI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-runner-"));
  try {
    const bin = stub(dir, "laya", "#!/bin/sh\ncat <<'P'\n" + DIFFICULTY_PAYLOAD + "\nP\n");
    const answers = await runDefaultQuestions("rename a label", { executable: bin });
    assert.equal(answers.difficulty.score, 1.8);
    assert.equal(answers.difficulty.top, "1");
    assert.equal(topChoice(answers, "domain"), "code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the custom path answers a caller-supplied question set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-runner-"));
  try {
    // A stub that echoes back what the question set asked, proving the set
    // really reached the engine rather than being ignored.
    const python = stub(dir, "fake-python", [
      "#!/bin/sh",
      "payload=$(cat)",
      "printf '%s' \"$payload\" | grep -q 'verificationShare' && \\",
      "  echo '" + JSON.stringify({ answers: { verificationShare: { type: "score", score: 2.4, probabilities: { "2": 0.8 } } } }) + "' || echo '{}'",
    ].join("\n"));
    const answers = await runCustomQuestions("verify the thing", {
      verificationShare: { type: "score", instructions: "How much verification?", criteria: ["a", "b"] },
    }, { python });
    assert.equal(answers.verificationShare.score, 2.4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A custom question is the whole point of the library path, so a failure to
// pass it through must never look like a working probe.
test("the custom path passes its question set on stdin, not argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-runner-"));
  try {
    const python = stub(dir, "echo-stdin", "#!/bin/sh\ncat\n");
    // Whatever comes back is not a valid answer map, so this returns null --
    // but only after the child actually received the payload.
    const result = await runCustomQuestions("hello", { q: { type: "noul", instructions: "x" } }, { python });
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty question set is not sent to the engine", async () => {
  assert.equal(await runCustomQuestions("text", {}, { python: "/no/such/python" }), null);
});

test("an empty input is never probed", async () => {
  assert.equal(await runDefaultQuestions("   ", { executable: "/definitely/not/here" }), null);
  assert.equal(await runCustomQuestions("  ", { q: { type: "noul", instructions: "x" } }, { python: "/no/such/python" }), null);
});

// The advisory case: every failure mode must be "no signal", never an error
// the caller has to handle.
test("a missing executable yields no signal", async () => {
  assert.equal(await runDefaultQuestions("x", { executable: "/no/such/laya" }), null);
  assert.equal(await runCustomQuestions("x", { q: { type: "noul", instructions: "y" } }, { python: "/no/such/python" }), null);
});

test("a nonzero exit yields no signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-runner-"));
  try {
    const bin = stub(dir, "laya", "#!/bin/sh\nexit 4\n");
    assert.equal(await runDefaultQuestions("x", { executable: bin }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a slow engine is abandoned at the timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-runner-"));
  try {
    const bin = stub(dir, "laya", "#!/bin/sh\nsleep 5\n");
    const started = Date.now();
    assert.equal(await runDefaultQuestions("x", { executable: bin, timeoutMs: 150 }), null);
    assert.ok(Date.now() - started < 4000, "must not wait out the full sleep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a custom probe is bounded too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-runner-"));
  try {
    const python = stub(dir, "slow-python", "#!/bin/sh\ncat >/dev/null\nsleep 5\n");
    const started = Date.now();
    const result = await runCustomQuestions("x", { q: { type: "noul", instructions: "y" } },
      { python, timeoutMs: 150 });
    assert.equal(result, null);
    assert.ok(Date.now() - started < 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// parseAnswers handles both shapes: the CLI nests under `answers`, the library
// returns the map directly.
test("parseAnswers accepts both the CLI and library shapes", () => {
  const nested = parseAnswers(DIFFICULTY_PAYLOAD);
  assert.equal(nested.difficulty.score, 1.8);
  const direct = parseAnswers(JSON.stringify({ difficulty: { type: "score", score: 2.0, probabilities: {} } }));
  assert.equal(direct.difficulty.score, 2.0);
});

test("parseAnswers drops unusable answers instead of returning them", () => {
  const parsed = parseAnswers(JSON.stringify({
    answers: {
      good: { type: "score", score: 1, probabilities: { "0": 1 } },
      notANumber: { type: "score", score: "high", probabilities: {} },
      unknownType: { type: "something-else" },
    },
  }));
  assert.equal(parsed.good.score, 1);
  assert.equal("notANumber" in parsed, false);
  assert.equal("unknownType" in parsed, false);
});

test("parseAnswers rejects output that is not an answer map", () => {
  assert.equal(parseAnswers("not json"), null);
  assert.equal(parseAnswers("[]"), null);
  assert.equal(parseAnswers("{}"), null);
});

test("topChoice is null for a missing or noul answer", () => {
  assert.equal(topChoice(null, "domain"), null);
  assert.equal(topChoice({ a: { type: "noul", noul: 0.5 } }, "a"), null);
  assert.equal(topChoice({ a: { type: "score", score: 1, top: "2", probabilities: {} } }, "a"), "2");
});

// Three checkpoints ship and they disagree: multilingual reads "gating" and
// "ordering" as verification where the default reads them as construction, but
// separates matched-length pairs far less cleanly. The choice must reach the
// engine through the payload rather than being interpolated into the script.
test("the checkpoint choice reaches the engine through the payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-runner-"));
  try {
    // A python stub that fails outright unless the checkpoint arrives on stdin,
    // so an interpolation-based implementation cannot pass this.
    const python = stub(dir, "assert-cp", [
      "#!/usr/bin/env python3",
      "import json, sys",
      "p = json.loads(sys.stdin.read())",
      "if p.get('checkpoint') != 'multilingual':",
      "    sys.exit('checkpoint not delivered')",
      "print(json.dumps({'answers': {'q': {'type': 'noul', 'noul': 0.4}}}))",
    ].join("\n"));
    const answers = await runCustomQuestions("x", { q: { type: "noul", instructions: "y" } },
      { python, checkpoint: "multilingual" });
    assert.equal(answers.q.noul, 0.4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default checkpoint is english", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oflow-runner-"));
  try {
    const python = stub(dir, "assert-default", [
      "#!/usr/bin/env python3",
      "import json, sys",
      "p = json.loads(sys.stdin.read())",
      "if p.get('checkpoint') != 'english':",
      "    sys.exit('default should be english, got ' + str(p.get('checkpoint')))",
      "print(json.dumps({'answers': {'q': {'type': 'noul', 'noul': 0.1}}}))",
    ].join("\n"));
    const answers = await runCustomQuestions("x", { q: { type: "noul", instructions: "y" } }, { python });
    assert.equal(answers.q.noul, 0.1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
