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

6. Publish from the tagged commit. This repository has no continuous
   integration and GitHub Actions are disabled for it, so the local checks in
   step 3 are the whole release gate. A GitHub release created before this
   point advertises a version npm does not have:

   ```bash
   npm publish --access public
   ```

   Then confirm the registry, and check `gitHead` against the tag. It must be
   the tagged commit, not merely `HEAD`; a docs commit made after tagging
   moves `HEAD` without changing what was published:

   ```bash
   npm view "oflow-workflow@$VERSION" version gitHead
   git rev-parse "v$VERSION^{}"
   ```

   Query the exact version rather than a `versions[...]` field selector: the
   dots in `0.5.2` are read as path syntax and yield nothing, which looks like
   propagation delay. A missing version does mean npm is still propagating —
   wait and re-run. Never re-publish a version that already succeeded.
7. Create the GitHub release only after the registry shows the version:

   ```bash
   awk "/^## $VERSION\$/{f=1;next} /^## /{f=0} f" CHANGELOG.md > /tmp/oflow-notes.md
   test -s /tmp/oflow-notes.md || { echo "no CHANGELOG section for $VERSION"; exit 1; }

   gh release create "v$VERSION" \
     --repo PolderLabs/oflow \
     --target main \
     --title "oflow $VERSION" \
     --verify-tag \
     --notes-file /tmp/oflow-notes.md
   ```

   The `test -s` guard is load-bearing: `v0.2.0` has no `CHANGELOG.md` section,
   so the `awk` writes an empty file and `gh` would otherwise create a release
   with a blank body. Writing a real file is also safer than process
   substitution, which depends on `gh` accepting a `/dev/fd` path.

   Notes come from that version's `CHANGELOG.md` section, not
   `--generate-notes`, which lists commits against the repository's previous
   owner and describes no user-visible change. `--verify-tag` stops a typo
   from creating a release on a missing tag, and the `oflow <version>` title
   keeps the list sorting. Add `--latest` to the newest release only, or
   GitHub can move the badge onto an older tag.
8. A version that never reached npm keeps a **draft** release, never a
   published one, and its body is written by hand: there is no `CHANGELOG.md`
   section to generate notes from. `v0.2.0` is the current example. It was
   tagged but skipped before publish, so the note says the version is retired
   rather than pending, that `0.2.1` carries the first shipped `0.2.x`, and
   that the number must not be reused.

## Publishing locally

Releases are published from a maintainer machine. No npm credential or
automation path exists on the GitHub side, so creating a GitHub release never
publishes to npm.

Authenticate interactively and verify the account before publishing:

```bash
npm login
npm whoami
npm publish --access public
```

`npm publish` runs `prepublishOnly` (`check:public`, then `build`) itself. The
tag still has to name the package version:

```bash
node -p "require('./package.json').version"
git describe --tags --exact-match
```

Do not pass `--provenance`. npm only attests provenance for a publish it can
attribute to a CI identity, and there is no CI identity here. If interactive 2FA
is impractical, use an npm automation token with publish rights configured in
the user-level `~/.npmrc`, never in the repository.

Any npm Trusted Publisher entry that still points at this repository's removed
`publish.yml` workflow should be deleted on npm. It can no longer be used, and a
left-over entry is a stale grant.

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
