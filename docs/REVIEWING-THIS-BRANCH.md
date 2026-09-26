# Reviewing this branch

`overnight/laya-2026-09-26` mixes two kinds of work and the history interleaves
them, so it is worth knowing which is which before reading the diff as a whole.

**Product fixes** — independent of Laya, each with its own tests, each
independently reviewable:

- a criterion toggle printed `issue updated (unknown)` instead of naming what
  landed;
- `--add-labels` silently no-opped on a label the project does not define;
- `--assignee` leaked raw GitLab JSON on a granular-scope 403;
- `work --author` sent a non-canonical username, and an empty result under an
  author filter read as "this person has no work";
- the agent instruction blocks told agents to run `oflow normalizeForbidden`,
  which is not a command;
- `capabilities --probe` worked but was absent from `--help`;
- `npm run build` never cleaned `dist`, so a deleted module kept shipping in the
  tarball;
- `oflow labels audit`, a new read-only command;
- roadmap and README claims that did not match the code.

**Laya work** — a local decision engine, entirely optional. One signal ships
(`assess --triage`), one aggregation works (`summariseBoardText`), nine
capabilities were measured and rejected. The measurements, including the ones
that constrain what the shipped signal can honestly be claimed to do, are in
[LAYA-TRIAGE.md](LAYA-TRIAGE.md).

**Nothing here is a release.** The version is untouched at 0.5.2 and no tag
was moved.

If these are to land separately, the product fixes cherry-pick by subject
rather than by range — `git log --oneline --grep` on `fix(plan)`, `fix(work)`,
`fix(templates)`, `fix(build)`, `feat(labels)` — because the two kinds of work
alternate rather than sitting in contiguous blocks.
