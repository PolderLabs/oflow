# Laya triage: what the engine is actually good for

**Status: module built and calibrated, not wired into any command.** The
exportable module and the scrum question set exist; nothing in oflow calls them
yet. This document records the measurements that decided what ships, so the
next reader does not re-derive them and so the "wire it in or not" decision is
made on evidence rather than on a tool's description.

## What Laya is

`laya` 0.3.10, installed in a local Python virtual environment, from
`convaiinnovations/laya`. Its own summary: a "fast, non-autoregressive System 1
decision engine with calibrated probabilities."

It is **not** an agentic tool. It cannot read a repository, run tests, or write
code. It takes a block of text and returns properties of it, and — the part
that matters here — **it accepts a custom question set**, so the properties do
not have to be the stock ones.

## The two call paths

| Path | Mechanism | Use |
|---|---|---|
| `runDefaultQuestions` | shells out to the `laya` CLI, `--predict --json` | stock router questions; no Python API needed |
| `runCustomQuestions` | library API, question set passed via stdin | domain-specific questions; the reason this is useful at all |

The custom path passes its JSON on **stdin**, never argv and never a temp file,
so no local path can leak into a process list.

## The headline finding: a question that is not a length meter

The engine's **stock difficulty score is close to useless.** Measured here:

- correlation with input word count: **r = 0.822**
- equal-word-count pairs of one genuinely trivial item against one genuinely
  hard item separated by **+0.024, −0.083, and +0.749** — one pair ran backwards

So a `trivial`/`easy`/`moderate`/`hard` band was built, measured, and **removed**.
It dressed a length meter up as a difficulty estimate, and a caller would
reasonably have trusted it.

A **custom** question survives the same control:

> How much of the work item is checking existing behaviour and evidence rather
> than writing new behaviour?

| Control | Result |
|---|---|
| mean separation (verification − construction), 6 matched pairs | **+1.001** |
| pairs with positive separation | **6 of 6** |
| min / max separation | +0.105 / +1.526 |
| **correlation with word count** | **r = +0.022** |

**r = 0.02 against length, versus 0.82 for the stock difficulty score.** This
question measures the thing it claims to measure.

One caveat found while reading the table: the engine's score and its
highest-probability *bucket* can disagree. "Confirm the helper output matches
expectations" scored **1.90** — above the 1.5 band edge — while its top
probability was still level 1, "mostly construction". The continuous score and
the argmax are not the same signal. oflow therefore bands on the score, never
on the engine's own bucket, and marks anything within 0.2 of an edge as
uncertain rather than rounding it to a side.

On a hand-labelled ten-item probe it was right on **7 of 10**, and repeated
runs are bit-identical. The three misses, stated rather than filtered: two are
items it scored `mid` that I had labelled `high` (a criteria-parsing check, and
the partial-apply resume decision), and one is "make it faster somehow", which
I had labelled `mid` and it scored `low`. Two of those three labels are
themselves contestable -- whether the resume decision is verification work or
construction is a judgement call -- so 7/10 is the raw figure, not one narrowed
after the fact.

That probe also says what the signal is *not*. It measures how much evidence
work an item implies, **not** how good the item is, and nothing about story
quality.

That is a genuine review-effort signal: an item that is mostly verification
costs a reviewer far more attention than its length suggests, which is exactly
what sprint planning tends to get wrong.

## Questions that were built, measured, and dropped

| Question | Verdict | Evidence |
|---|---|---|
| `verificationShare` | **kept** | 6/6 matched pairs; r=0.02 vs length; deterministic |
| `executorFit` | dropped | 5/10; called every verify/audit/confirm task agent-suitable, including ones needing human judgement |
| `specificationGap` | dropped | wrong in *direction*, not just noisy — see below |
| stock difficulty band | dropped | r=0.82 vs length; equal-length pairs separated by +0.02, −0.08, +0.75 |

Both dropped questions failed in a way that would have been actively harmful:
`executorFit` would have handed mechanical work to an agent that needed a human,
and `specificationGap` was worse than a wrong-direction bug, because the scale made
it unmistakable: the question is "could an engineer start this without asking a
question", so 1.0 means *fully specified*. It scored "rename the button label"
at **0.09** — judging the single most specific item in the set to be almost
entirely unspecified — and "make it faster somehow" at 0.073. Read on a
"1.0 = specified" scale the answers are close to inverted. A hint that is wrong
in these ways is worse than no hint.

## Two environmental traps

**`--predict` cannot use the default device here.** It aborts inside a broken
triton build (`Python.h: No such file or directory` — no CUDA toolkit headers).
Both paths force CPU. A real call costs **~3.7s**, almost all engine start-up.

**The original 4s timeout was inside that cost.** It was a coin flip: a slower
machine turned every successful call into a silent `null`, which is
indistinguishable from "Laya is not installed" and makes the feature look dead
rather than flaky. The default is now 20s, with a behavioural test that a 5s
stub call must still return a signal.

## The checkpoint disowns its own confidences

Every run emits:

> `RuntimeWarning: laya: this checkpoint ships invalid temperatures or values
> outside [0.5, 5] ... Treat confidence from the affected entries as
> uncalibrated.`

Forwarding that would mean passing along a figure the engine explicitly
disowned, so the module reports `confidence: 0` and callers must not gate on it.

## What is in the code

- **`src/laya-runner.ts`** — the engine wrapper. Text in, answers out, no oflow
  types, no GitLab, no npm dependency on the Python engine. Every failure mode
  returns `null` rather than throwing, so no caller can be broken by Laya.
- **`src/laya-triage.ts`** — the earlier stock-questions wrapper, kept for the
  CLI path and its existing tests.
- **`src/laya-scrum.ts`** — the calibrated question set and the band reader, with
  the calibration table in its header.

## Open questions for the maintainer

1. **Should `oflow-workflow` gain an `exports` map** so these modules are
   importable by another planning tool? That changes what the published package
   *is* — from CLI-only to also a library — so it is a product decision, not a
   detail. Deliberately not done on this branch. The modules are already
   portable: no GitLab imports, no oflow types, a stable text→signal contract.
2. **Should `assess` surface a verification-share hint?** It would be advisory
   only, behind an explicit opt-in flag, and must show its own uncertainty
   rather than rounding to a band. A story heavy in verification work is
   genuinely different work to review, and oflow currently has no way to say so.
3. **Re-calibrate when a newer checkpoint lands.** The confidence warning is the
   signal that the numbers would be worth trusting; until it disappears, the
   score should be shown with its uncertainty and never used to gate.

Reproduce the calibration with `OFLOW_LAYA_PYTHON` pointed at the interpreter
that has `laya` installed. The stub-level suite needs no Python at all.
