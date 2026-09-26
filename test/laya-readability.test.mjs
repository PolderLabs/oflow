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
