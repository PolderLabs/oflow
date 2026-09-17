# Releasing oflow

This repository publishes the npm package **`oflow-workflow`**. The installed
command remains **`oflow`**. The unscoped npm name `oflow` is owned by an
unrelated package, so release commands must use `oflow-workflow`.

## Maintainer checklist

1. Make sure the working tree is clean and the public-content policy passes.
2. Update `version` in `package.json` and `package-lock.json` together.
3. Run the complete local release checks:

   ```bash
   npm run check:public
   npm test
   npm run typecheck
   npm pack --dry-run
   ```

4. Commit the version change and push `main`.
5. Create an annotated tag that exactly matches the package version:

   ```bash
   VERSION=$(node -p "require('./package.json').version")
   git tag -a "v$VERSION" -m "Release v$VERSION"
   git push origin "v$VERSION"
   ```

6. Create the GitHub release after the tag is pushed:

   ```bash
   gh release create "v$VERSION" \
     --repo PolderLabsVOF/oflow \
     --target main \
     --generate-notes
   ```

## Publishing from GitHub Actions

The manual [`publish` workflow](../.github/workflows/publish.yml) checks out
an existing tag, reruns all release checks, verifies that the tag matches the
package version, and publishes the package with npm provenance.

Before running it, configure an npm publishing token as the repository secret
`NPM_TOKEN`. Never commit the token, place it in an issue, or pass it as a
command-line argument. Then run the workflow with the exact tag, for example
`v0.1.0`.

The workflow is intentionally manual. Creating a GitHub release does not
silently publish to npm, and ordinary CI never receives npm credentials.

## Publishing locally

For a one-off local publish, authenticate interactively and verify the account
before publishing:

```bash
npm login
npm whoami
npm publish --access public
```

The `--provenance` flag is used by the GitHub Actions workflow, where npm can
verify the CI identity. Local publishing should omit it.

Confirm the result without exposing credentials:

```bash
npm view oflow-workflow version
```

Do not delete or overwrite a published version to recover from a release
mistake. Publish a corrected patch version and use npm deprecation tooling only
when a published version needs a warning.

## Consumer install

Users install the package globally, then invoke the `oflow` executable:

```bash
npm install --global oflow-workflow
oflow --help
```

The same package works from a Windows PowerShell terminal and from the VS Code
integrated terminal. If VS Code was open during a global install, restart its
integrated terminal so its `PATH` reflects npm's global bin directory.
