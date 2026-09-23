# JSON cookbook

Machine-readable output is the stable agent contract. Every command accepts
`--json`. Prefer these shapes over scraping Markdown.

Public-content rules apply: hosts use `gitlab.example.test` (or `*.test`),
paths use `team/project`, identities are synthetic.

## Shared rules

- Plan-producing commands always return a top-level `planPath` alongside the
  full `path` and `plan` object.
- Work listing always includes the effective `state` and `query.state`.
- Errors print `oflow: <message>` on stderr and exit `1`; they are not JSON.
- Tokens, cookies, and private keys never appear in JSON.

## `oflow identity --json`

```bash
oflow identity --json
oflow identity --with-email --json
```

Returns the authenticated GitLab principal. `email` is `null` by default and
is only populated with `--with-email` when GitLab marks that email public.
The response never includes token material.

```json
{
  "host": "gitlab.example.test",
  "source": "environment",
  "id": 7,
  "username": "alice",
  "name": "Alice",
  "email": null
}
```

## `oflow work --json`

```bash
oflow work --state closed --json
oflow work --state all --mine --json
oflow work --iid 42 --json
```

List response (abridged):

```json
{
  "state": "closed",
  "issues": [
    {
      "iid": 7,
      "title": "Closed story",
      "state": "closed",
      "issueType": "task",
      "labels": [],
      "milestone": null,
      "iteration": null,
      "assignees": [],
      "startDate": null,
      "dueDate": null,
      "weight": null,
      "taskCompletion": null,
      "parent": null,
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "webUrl": "https://gitlab.example.test/team/project/-/issues/7"
    }
  ],
  "query": { "state": "closed", "issueLimit": 100, "issueFilters": {}, "mine": false },
  "workItemsMayBeTruncated": false,
  "pagination": { "page": 1, "perPage": 100, "total": 1, "hasNextPage": false },
  "cache": { "source": "remote", "savedAt": "…", "ageSeconds": 0, "actorUsername": null },
  "warnings": []
}
```

Normalized single-IID read:

```json
{
  "source": "normalized-issue-read",
  "state": "opened",
  "issue": { "iid": 9, "issueType": "issue", "title": "…" }
}
```

## `oflow sync --summary --json`

```bash
oflow sync --summary --cached --json
```

Returns a compact `SyncSummary`: `generatedAt`, `cache`, `project`,
`repository`, `query`, `workItems`, `mergeRequests`, `pipelines`, `planning`,
`story`, `stats`, `planningHealth`, `warnings`. Full `sync --json` adds notes
and richer models.

## Plan responses (`plan … --json`, `approve`, `apply`, `verify <plan>`)

```json
{
  "planPath": "/abs/path/.oflow/state/plans/<uuid>.json",
  "path": "/abs/path/.oflow/state/plans/<uuid>.json",
  "plan": {
    "managedBy": "oflow",
    "version": 2,
    "id": "<uuid>",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "sessionId": "…",
    "expiresAt": "2026-01-02T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "state": "draft",
    "digest": "…",
    "operation": { "kind": "issue.note.create", "host": "gitlab.example.test", "projectPath": "team/project", "issueIid": 42, "body": "…" },
    "result": { "kind": "issue.note.create", "iid": 42, "noteId": 10, "noteReused": false },
    "verification": {
      "passed": true,
      "checks": [{ "field": "note.body", "expected": "…", "actual": "…", "passed": true }],
      "reasons": []
    }
  }
}
```

Operation `kind` values include: `issue.create`, `issue.update`,
`issue.note.create`, `issues.notes.create`, `issues.labels.update`,
`issues.planning.update`, `issues.iteration.update`,
`issue.iteration.update`, label/milestone/board/board-list create/update,
`merge_request.create`, `merge_request.update`.

Bulk results put per-IID outcomes under `plan.result.issues`
(`iid`, optional `noteId`/`noteReused`/`labels`/`milestone`/…).

`apply --yes` is valid only for `issue.note.create`. All other mutations keep
the explicit approve → apply → verify path.

## `oflow audit --json`

Append-only JSONL at `.oflow/state/audit.jsonl`. `oflow audit --json` returns:

```json
{
  "path": "…/.oflow/state/audit.jsonl",
  "events": [
    {
      "version": 1,
      "at": "2026-01-01T00:00:00.000Z",
      "action": "applied",
      "planId": "<uuid>",
      "state": "applied",
      "operation": { "kind": "issues.notes.create", "host": "…", "projectPath": "team/project", "target": "#42, #43" },
      "details": { "issueCount": 2, "resultCount": 2, "verificationPassed": true }
    }
  ],
  "query": { "limit": 50 },
  "mayBeTruncated": false
}
```

`action` is one of: `created`, `approved`, `applied`, `apply-failed`,
`verified`, `discarded`, `delegated`, `receipt`, `lifecycle-forced`.

## Delegated apply + receipt

`apply <plan> --delegate` prints a `DelegatedActionRequest`:

```json
{
  "execution": "delegated",
  "backendPreference": "gitlab-mcp",
  "action": { "name": "merge_request.create", "arguments": { "project": "team/project", "sourceBranch": "…", "targetBranch": "main", "title": "…" } },
  "afterExecution": { "command": "oflow apply <plan.json> --receipt <file>" }
}
```

Receipt file passed to `apply --receipt`:

```json
{
  "backend": "gitlab-mcp",
  "action": "merge_request.create",
  "executedAt": "2026-01-01T00:00:00.000Z",
  "success": true,
  "result": { "iid": 9, "web_url": "https://gitlab.example.test/team/project/-/merge_requests/9" }
}
```

## Verification (`verify --story --json`)

```json
{
  "storyIid": 42,
  "mergeRequest": { "iid": 3, "state": "merged", "draft": false },
  "pipeline": { "id": 10, "status": "success" },
  "pipelinePolicy": "enabled",
  "ciConfigPresent": true,
  "warnings": [],
  "passed": true,
  "criteria": []
}
```

- `pipelinePolicy: "disabled"` skips the pipeline gate
  (`.oflow/config.json` → `workflow.pipeline`).
- Enabled policy with no `.gitlab-ci.yml` and no pipeline evidence emits a
  warning instead of a permanent block.

## Related docs

- [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md) — host integration boundary
- [SCRUM-PLANNING.md](SCRUM-PLANNING.md) — command surface
- [FIELD-PARITY.md](FIELD-PARITY.md) — REST / glab / delegated field mapping
- [PUBLIC-CONTENT-POLICY.md](PUBLIC-CONTENT-POLICY.md) — what may ship
