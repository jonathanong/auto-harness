# Release the npm client

The `auto-harness-client` package is released only by the GitHub Actions **Release client**
workflow. Each successful publish creates the immutable `client-v<version>` git tag, publishes the
package to npm with provenance, then publishes a GitHub Release for that tag with generated notes.
Normal pull requests must leave `modules/client/package.json` at its current version; CI rejects
version changes in pull requests.

The checked-in dispatch Action has a separate distribution policy: consumers pin a reviewed full
commit SHA as documented in [`actions/dispatch`](../actions/dispatch/README.md). It does not use a
moving branch ref or share the client's semver tags.

## Prerequisites

- The repository Actions secret `RELEASE_TOKEN` can write repository contents and its owner is
  allowed to push the release commit and tag to `main`.
- The GitHub `npm-publish` environment allows deployments only from the `main` branch. It does not
  require a reviewer because starting the manual workflow is the release authorization.
- npm trusted publishing for the unscoped `auto-harness-client` package names this repository,
  `.github/workflows/release-client.yml`, and the `npm-publish` environment. npm authentication is
  OIDC; do not configure `NPM_TOKEN` or `NODE_AUTH_TOKEN` for this workflow.

## Publish

1. Confirm the intended client code is on `main` and its required CI checks passed.
2. In GitHub Actions, open **Release client**, select **Run workflow**, keep the branch set to
   `main`, and choose `patch`, `minor`, or `major`.
3. Wait for the workflow to validate the package, commit the selected version to `main`, create the
   matching `client-v<version>` tag, publish with npm provenance, and create the matching GitHub
   Release.
4. Confirm the workflow succeeded and the exact version is visible on npm and GitHub Releases.

The workflow rechecks `origin/main` before atomically pushing the release commit and tag. Concurrent
runs cannot both record the same version: the losing run fails and must not publish.

## Retry and recovery

- If a run fails before it pushes the release commit and tag, rerun it.
- If the atomic push succeeded but npm publishing failed, rerun the same run. It checks out and
  publishes the exact unpublished tag, even if later commits advanced `main`.
- If npm publishing succeeded but GitHub Release creation failed, rerun the same run. It checks out
  the exact tag identified by that run's tag annotation, skips npm publishing, and creates or
  verifies the GitHub Release, even if a later client release advanced `main`.
- If a rerun reports that it was superseded, inspect the original run, the `client-v<version>` tag,
  npm, and GitHub Releases. Do not delete or move a release tag. Start a fresh workflow dispatch
  only when another version is intended.
- Never repair a release by changing the manifest version in a pull request. Fix release automation
  in a normal PR while leaving the version unchanged, then use **Release client**.
