import assert from "node:assert/strict";
import test from "node:test";

import { readTextReadability } from "../dist/laya-readability.js";

// A precondition check, not a classifier. Every failure mode must be `null`
// rather than a confident "unreadable", because a caller that cannot reach the
// engine must not conclude the input is in another language.

test("readability follows the engine answer", async () => {
  assert.deepEqual(
    await readTextReadability("Verify the rollback path", async () => [true]),
    { readable: true, script: null },
  );
  assert.deepEqual(
    await readTextReadability("Überprüfen Sie den Rollback-Pfad", async () => [false]),
    { readable: false, script: null },
  );
});

// Blank is not a language problem. Reporting an empty field as unreadable
// would file it under the wrong failure entirely.
test("blank text is readable, not a language failure", async () => {
  const result = await readTextReadability("   ", async () => [false]);
  assert.equal(result.readable, true);
  assert.equal(result.script, null);
});

// The engine could not decide. That is not the same as unreadable, and a
// caller must be able to tell the two apart.
test("an undecided or unavailable probe yields null, not false", async () => {
  assert.equal(await readTextReadability("x", async () => null), null);
  assert.equal(await readTextReadability("x", async () => [null]), null);
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
    return [true];
  });
  assert.deepEqual(seen, ["padded"]);
});
