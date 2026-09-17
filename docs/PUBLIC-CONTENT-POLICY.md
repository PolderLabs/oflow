# Public content policy

This repository is public. Treat every tracked file, test fixture, generated
example, image, commit, issue, and pull request as publishable to the internet.

## Never commit

- Client, employer, partner, school, or project names that are not public.
- Private GitLab hosts, project paths, issue URLs, group names, or MCP endpoints.
- Employee, teammate, customer, or user names, usernames, emails, or identifiers.
- Local filesystem paths that reveal a person's username or private checkout.
- Access tokens, cookies, API keys, private keys, credentials, or raw API dumps.
- Screenshots, exports, logs, or generated files containing any of the above.

## Use instead

- `gitlab.example.com`, `gitlab.example.test`, and `example.test` for hosts.
- `team/project`, `group/product`, and `story/42` for paths and examples.
- `developer`, `test-user`, and `Test User` for synthetic identities.
- Minimal fixtures that contain only the fields needed by the test.
- Links to public vendor documentation rather than copied private responses.

Credentials belong in user-level configuration or protected CI variables, never
in `.oflow/`, documentation, tests, screenshots, logs, or command arguments.

## Required checks

Before pushing, run:

```bash
npm run check:public
npm test
npm run typecheck
npm pack --dry-run
```

The public-content scanner checks tracked and non-ignored working-tree files for
known token formats, private-key headers, non-placeholder email addresses,
absolute user paths, and unapproved external Git hosts. It is a guardrail, not a
substitute for human review: when in doubt, remove the data and use a
placeholder. CI runs the same check on every push and pull request.

If private data is discovered after a commit or push, remove public access and
rotate/revoke any exposed credential immediately. Deleting the file in a later
commit is not enough because Git history and pull-request metadata can retain
it.
