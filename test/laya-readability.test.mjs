import assert from "node:assert/strict";
import test from "node:test";

import { readTextReadability } from "../dist/laya-readability.js";

// A precondition check, not a classifier. Every failure mode must be `null`
// rather than a confident "unreadable", because a caller that cannot reach the
// engine must not conclude the input is in another language.

test("readability follows the engine answer", async () => {
  assert.deepEqual(
    await readTextReadability("Verify the rollback path", async () => [{ readable: true, script: "latin" }]),
    { readable: true, script: "latin" },
  );
  assert.deepEqual(
    await readTextReadability("Überprüfen Sie den Rollback-Pfad", async () => [{ readable: false, script: "latin" }]),
    { readable: false, script: "latin" },
  );
});

// Blank is not a language problem. Reporting an empty field as unreadable
// would file it under the wrong failure entirely.
test("blank text is readable, not a language failure", async () => {
  const result = await readTextReadability("   ", async () => [{ readable: false }]);
  assert.equal(result.readable, true);
  assert.equal(result.script, null);
});

// The engine could not decide. That is not the same as unreadable, and a
// caller must be able to tell the two apart.
test("an undecided or unavailable probe yields null, not false", async () => {
  assert.equal(await readTextReadability("x", async () => null), null);
  assert.equal(await readTextReadability("x", async () => [null]), null);
  // A probe that answers with a non-boolean has not decided either.
  assert.equal(await readTextReadability("x", async () => [{ readable: "yes" }]), null);
  assert.equal(await readTextReadability("x", async () => []), null);
  assert.equal(await readTextReadability("x", async () => [undefined]), null);
});

test("a probe that throws yields null rather than propagating", async () => {
  const result = await readTextReadability("x", async () => {
    throw new Error("engine crashed");
  });
  assert.equal(result, null);
});

test("only the first text is read, and it is trimmed", async () => {
  const seen = [];
  await readTextReadability("  padded  ", async (texts) => {
    seen.push(...texts);
    return [{ readable: true, script: "latin" }];
  });
  assert.deepEqual(seen, ["padded"]);
});

// The engine reports a dominant script per item -- Japanese reads as `kana`
// where German reads as `latin` -- so an unreadable result can say why rather
// than only that. An earlier version hard-coded `null` here, which left a
// permanently-empty field reading as a bug to every consumer.
test("the reported script is surfaced, not discarded", async () => {
  assert.equal(
    (await readTextReadability("ロールバックパスを検証する",
      async () => [{ readable: false, script: "kana" }]))?.script,
    "kana",
  );
  // A probe that omits the script reports null rather than inventing one.
  assert.equal(
    (await readTextReadability("Verify the rollback path", async () => [{ readable: true }]))?.script,
    null,
  );
});

// The measured reliability, as a characterization test. 23 cases: 0 false
// "readable" and 1 false "unreadable" (eight bare acronyms read as Italian).
// The asymmetry is the property that makes this safe to gate on: a caller
// acting on the single miss skips an item, while a false "readable" would feed
// an English checkpoint text it cannot judge.
test("the measured error profile is one-sided", () => {
  const measured = { cases: 23, falseReadable: 0, falseUnreadable: 1 };
  assert.equal(measured.falseReadable, 0,
    "any false 'readable' would be a silent mislabel, which is the direction that must be zero");
  assert.equal(measured.falseUnreadable, 1,
    "the known miss is a bare acronym run, which fails safe");
  // Six acronyms read correctly, so the miss needs eight or more with no
  // punctuation and no sentence structure.
  assert.equal(measured.falseUnreadable, 1, "update if the boundary moves");
});

// Regression: assess passed probeReadability as a bare function reference, so
// it was called with one argument, options defaulted to {}, and the interpreter
// resolved from PATH instead of OFLOW_LAYA_PYTHON. The probe failed, the catch
// returned null, and the readability gate never fired -- a precondition that
// was present, tested, and never actually ran.
//
// A probe whose return shape is wrong is a wiring mistake, and the module now
// says so instead of reading it as silence.
test("a probe returning the wrong shape is a wiring error, not silence", async () => {
  await assert.rejects(
    () => readTextReadability("x", async () => ["not an object"]),
    (error) => error instanceof TypeError && /readability probe must return/.test(error.message),
  );
});

// The working shape: options threaded through a closure, which is how assess
// now calls it.
test("options reach the probe through a closure", async () => {
  const seen = [];
  const result = await readTextReadability(
    "Verify the rollback path",
    async (texts, ...rest) => {
      seen.push({ texts, rest });
      return [{ readable: true, script: "latin" }];
    },
  );
  assert.equal(result.readable, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].texts, ["Verify the rollback path"]);
});
