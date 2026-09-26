# Reviewing this branch

The work was done on one branch, and it mixes two kinds of thing. There is now a
`product-fixes` branch that separates them.

## `product-fixes` — the mergeable part

Branched from `main`, containing seven commits and no Laya code:

| commit | what it fixes |
|---|---|
| `fix(plan)` | a criterion toggle printed `issue updated (unknown)` instead of naming what landed |
| `fix(plan)` | `--add-labels` silently no-opped on a label the project does not define |
| `fix(plan)` | `--assignee` leaked raw GitLab JSON on a granular-scope 403 |
| `fix(work)` | `work --author` sent a non-canonical username, and an empty result under an author filter read as "this person has no work" |
| `feat(labels)` | `oflow labels audit`, a new read-only command |
| `fix(build)` | `npm run build` never cleaned `dist`, so a deleted module kept shipping in the tarball |
| `fix(templates)` | the agent instruction blocks told agents to run `oflow normalizeForbidden`, which is not a command |

Verified in isolation from `main`: **298 tests, 298 passing, 0 skipped**, and
`typecheck`, `check:public` and `pack --dry-run` all green. It contains no
Laya source.

**It is ready to merge.** Checked by trial merge rather than assumed: merging
`product-fixes` into `main` completes with no conflicts, no unmerged paths, and
the merged tree passing 298 tests plus `typecheck` and `check:public`. The
trial branch was deleted and `main` left untouched, since publishing is your
call and not one this branch should make.

That is fewer tests than the experiment branch (342) because the Laya test
files are simply not on it -- the difference is the experiment's own suite, not
skipped coverage. Neither branch skips anything unconditionally.

Review that one first. It is the diff most likely to be merged, and it stands
without the experiment.

## `overnight/laya-2026-09-26` — the experiment

A local decision engine, entirely optional. Both scoring paths are **withdrawn on measurement**: `assess --triage` at 75%
false alarms on story-shaped input, and `summariseBoardText` at 100%.

[Ff]ifteen further capabilities were rejected outright, among them a label
shortlister that scored *below* chance, and a phishing screen whose worst
false alarm -- "Approval is required before apply" -- outranks three of the
five real attacks it was meant to catch. Counting the two withdrawn paths as
well, that is seventeen measured and not shipped — the fifteen rejections above, plus the two withdrawn paths. A per-item checkpoint router, a version upgrade and a moderation preset are among the fifteen, and each was expected to help. The portable runner, question
set and full measurement record remain, and
[LAYA-TRIAGE.md](LAYA-TRIAGE.md) carries the canonical numbered list every
other count here is derived from. The measurements — including the ones
that constrain what the shipped signal can honestly be claimed to do — are in
[LAYA-TRIAGE.md](LAYA-TRIAGE.md).

## Merging order matters, and the obvious order breaks

Merging `product-fixes` into `main` is clean, and was verified by trial merge.
But merging the experiment **on top of a post-fix `main` conflicts**, because
both branches independently added four of the same files:

| file | `product-fixes` | experiment | differing lines |
|---|---:|---:|---:|
| `src/labels-audit.ts` | 215 | 219 | 4 |
| `scripts/check-portable.mjs` | 100 | 115 | 23 |
| `test/labels-audit.test.mjs` | 230 | 302 | 74 |
| `test/agent-instructions.test.mjs` | 96 | 170 | 152 |
| `src/templates.ts` | — | — | conflict, both edited |

`labels-audit.ts` is effectively the same code. The others diverged, because
the experiment added coverage while the fix branch did not: the instruction
test grew from 96 to 170 lines, and the labels test from 230 to 302.

So the merge order is a decision, not a formality. `labels-audit.ts` resolves
by taking either copy. For the two tests, take the experiment's version and
re-run -- it is a superset. `src/templates.ts` is a genuine text conflict in
the agent instruction block, which both branches edited for different reasons:
the fix branch removed a phantom command, the experiment corrected the triage
description. Both edits are wanted.

Merging the experiment **first** and then `product-fixes` has the same
conflicts, since the overlap is additive from both sides. Resolving by hand is
unavoidable, and this note is where to start.

## How the split was produced

Cherry-picking the seven commits onto `main` conflicted in `docs/ROADMAP.md`
only, because the roadmap was edited repeatedly between them while this
experiment was in progress. Every commit's code applied cleanly.

**Take `main`'s roadmap, not this branch's.** Doing the opposite was tried and
reverted: it left the fixes branch carrying the Laya sections and three links
to `docs/LAYA-TRIAGE.md`, a file that does not exist there. A fixes-only branch
whose roadmap claims features absent from its own diff is misleading, and
`check:public` does not catch it.

In short:

```bash
git checkout -b product-fixes main
git cherry-pick -n <commit>
# docs/ROADMAP.md will conflict; keep main's copy:
git checkout main -- docs/ROADMAP.md
git commit
```

Verified on the finished branch: 298 tests passing, and `typecheck`,
`check:public` and `pack --dry-run` green.

## Nothing here is a release

The version is untouched at 0.5.2 and no tag was moved on either branch.
