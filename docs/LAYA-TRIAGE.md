# Laya triage: calibration findings

**Status: experimental, not wired into any oflow command.** The module exists
(`src/laya-triage.ts`) and is fully tested, but nothing in oflow calls it yet.
This document records what the engine actually does, measured, so the next
person does not have to re-derive it — and so the decision to wire it in, or
not, is made on evidence rather than on a tool's description.

## What Laya is

`laya` 0.3.10, installed in a local Python virtual environment, from
`convaiinnovations/laya`. Its own summary: a "fast, non-autoregressive System 1
decision engine with calibrated probabilities."

It is **not** an agentic tool. It cannot read a repository, run tests, or
write code. It takes a block of text and returns properties of it:

| Property | Meaning |
|---|---|
| `difficulty` | a 0–3 score with a documented legend, plus a confidence |
| `domain` | `code`, `math_or_logic`, `writing`, `factual_lookup`, `data_analysis`, `chitchat` |
| `needs_tools` | probability the task needs external tools |
| `is_sensitive` | probability the content is sensitive |

## What the measurements showed

### Difficulty tracks input length

Across a ten-item probe spanning trivial to hard, the correlation between word
count and Laya's difficulty score was **r = 0.822**.

### The equal-length control

Correlation alone is not proof of a confound, so the decisive test: pairs of one
genuinely trivial item and one genuinely hard item, written to the same word
count. If difficulty separates them, it is measuring something real.

| Pair (matched length) | Trivial | Hard | Separation |
|---|---|---|---|
| 1 | rename the button label to Cancel (6w) | migrate sessions to signed rotating scoped tokens (7w) | **+0.024** |
| 2 | bump the timeout constant from five to ten (8w) | design resumable partial apply surviving process death (7w) | **−0.083** |
| 3 | add a test asserting the parser rejects empty input (9w) | prove absence of drift sound under concurrent modification (8w) | **+0.749** |

Mean separation **0.230**, and one pair is negative — the "trivial" item scored
*higher* than the "hard" one.

**Conclusion: the difficulty score is close to a length meter.** It is not a
difficulty estimate and must not be presented as one.

### Domain classification is better but still unreliable

It correctly separated both non-code probe items, but mislabelled several code
items — the resumable-apply protocol came back as `writing`, and a one-line
constant bump came back as `math_or_logic`. Usable as a weak hint; not usable
for routing.

## Consequences for oflow

The first version of this module exposed a `band` field with `trivial`/`easy`/
`moderate`/`hard` labels. **That was removed.** A band label computed from a
length-correlated score presents a proxy as an estimate, and callers trust
labels. The raw `score` remains available in `--json` for inspection; nothing
in oflow may branch on it.

## Two environmental traps

**`--predict` cannot use the default device here.** It aborts inside a broken
triton build (`Python.h: No such file or directory` — no CUDA toolkit headers).
The probe forces `--device cpu`. A real call costs **~3.7s**, almost all of it
engine start-up.

**The original 4s timeout was inside that cost.** It was a coin flip: a slower
machine, or one under load, turned every successful call into a silent `null`,
which is indistinguishable from "Laya is not installed" and makes the feature
look dead rather than flaky. The default is now 20s, and a behavioural test
pins it by requiring a 5s stub call to still return a signal.

## The checkpoint disowns its own confidences

Every run emits:

> `RuntimeWarning: laya: this checkpoint ships invalid temperatures or values
> outside [0.5, 5] ... Treat confidence from the affected entries as
> uncalibrated.`

Forwarding that confidence would mean passing along a number the engine
explicitly disowned, so the module reports `confidence: 0` and never a
plausible-looking figure.

## What is in the code

`src/laya-triage.ts` — plain text-in, domain-out, no GitLab types, so it can
back planning in other tools unchanged. It is advisory by construction:
`triageText` returns `null` for every failure mode (missing binary, timeout,
crash, unparseable output, non-numeric score), so no oflow command can be
broken by Laya. oflow takes **no npm dependency** on it; the engine is
discovered at runtime, which preserves the bare-`npm-install` constraint.

21 tests, all mutation-verified:

| Guarantee | Mutation that must turn the suite red |
|---|---|
| probe errors degrade to `null` | let `execFile` rejection propagate |
| the timeout is bounded | delete the `timeout` option |
| the timeout is generous enough | set the default back to 4000ms |
| uncalibrated confidence is not forwarded | forward the raw confidence |
| a non-numeric score yields no signal | accept a string score |

## If you want to revisit this

The interesting question is not whether the current checkpoint is good — it
measurably is not, on difficulty — but whether a **calibrated** checkpoint
separates equal-length trivial from hard. If a future version clears the
equal-length control with consistent positive separation, `band` becomes
defensible and the module could grow one. Until then, treat Laya as a
length-and-vocabulary classifier, which is roughly what it is.

Reproduce with `OFLOW_LAYA_E2E=1` set and the real engine on `PATH`; the
stub-level suite needs no Python at all.
