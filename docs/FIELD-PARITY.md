# Field parity: REST, glab, and delegated actions

Release requirement for 0.3.0. Before advertising labels, epic links, dates,
weight, or milestone as portable capabilities, every transport that can apply
an approved issue update must map the same fields.

## Scope

| Layer | Owner | Write path |
| --- | --- | --- |
| Plan / policy | `src/plan.ts` | Validates `GitLabIssueUpdate`, records `expectedUpdatedAt`, digest, approve/apply/verify |
| REST | `src/gitlab.ts` `updateIssue` | `PUT /projects/:path/issues/:iid` with form fields from `GitLabIssueUpdate` |
| glab | `src/executor.ts` `changesToFields` | `glab api … PUT` with `--field key=value` pairs |
| Delegated MCP | `src/plan.ts` `applyPlanDelegated` | Emits a canonical action for runtime MCP; receipt re-enters `ingestExecutionReceipt` |

Canonical plan types (`GitLabIssueUpdate` in `src/types.ts`):

- `title`, `description`
- `labels`, `add_labels`, `remove_labels`
- `milestone`, `milestone_id`, `epic_id`
- `issue_type`, `due_date`, `weight`
- `assignee_ids`, `state_event`

## Parity matrix

| Field | REST form | glab `--field` | Delegated | Notes |
| --- | --- | --- | --- | --- |
| `title` | yes | yes | n/a (MR create/update only today) | |
| `description` | yes | yes | MR description via `--description-file` | |
| `labels` (replace) | yes | yes | not yet | |
| `add_labels` / `remove_labels` | yes | yes | not yet | arrays joined with `,` for glab |
| `milestone` (title) | yes | yes | not yet | REST accepts title or id depending on API; plan normalizes to id when resolving |
| `milestone_id` | yes | yes (`String`) | not yet | `0` clears |
| `epic_id` | yes | yes (`String`) | not yet | Premium/Ultimate; `0` clears |
| `due_date` | yes | yes | not yet | ISO `YYYY-MM-DD` |
| `weight` | yes | yes (`String`) | not yet | non-negative integer |
| `issue_type` | yes | yes | not yet | `issue` \| `incident` \| `test_case` \| `task` |
| `assignee_ids` | yes | yes (comma-joined) | not yet | |
| `state_event` | yes | yes | not yet | `close` \| `reopen` |
| iteration | GraphQL `IssueSetIteration` only | not via glab PUT | not yet | not a REST form field on issue update |

## Gaps closed in this pass

1. **glab field drop** — `changesToFields` previously omitted `labels`,
   `milestone`, `epic_id`, `due_date`, and `weight`, so a glab-only apply
   silently failed to write fields that REST would write. Those keys are now
   forwarded with the same string coercion the glab CLI expects.
2. **Documented contract** — this matrix and
   [JSON-COOKBOOK.md](JSON-COOKBOOK.md) record the portable surface so
   capability advertising stays honest.

## Remaining gaps (not claimed as portable yet)

| Gap | Why | Sketch |
| --- | --- | --- |
| Iteration on glab/delegated | Requires GraphQL mutation, not issue PUT | Dedicated delegated action or glab GraphQL call under the same plan lifecycle |
| Cross-type work-item conversion | REST `PUT /issues` 404s for custom Work Item types | GraphQL `workItemConvert` under `plan issue update --type` (roadmap friction #10) |
| Epic assignment without Premium | GitLab Premium/Ultimate only | Report capability unavailable rather than silent no-op |
| Delegated bulk notes / labels | Receipt path is proven for `merge_request.create` first | Extend `DelegatedActionRequest` + receipt verify per bulk kind |

## Verification

- `test/executor.test.mjs` asserts glab forwards `labels`, `epic_id`,
  `due_date`, `weight`, and `milestone` with no token in argv.
- REST path remains covered by `test/plan.test.mjs` issue-update apply/verify.
- Synthetic compatibility fixtures under `test/fixtures/compat/` exercise the
  host/transport matrix without credentials (`test/compat-fixtures.test.mjs`).

## Related docs

- [GITLAB-INTEGRATION.md](GITLAB-INTEGRATION.md) — hybrid backend decision
- [VNEXT-ARCHITECTURE.md](VNEXT-ARCHITECTURE.md) — backend-neutral actions
- [JSON-COOKBOOK.md](JSON-COOKBOOK.md) — stable machine contract
