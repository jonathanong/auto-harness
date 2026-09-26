# Release the GitHub Actions

The checked-in Actions (`actions/dispatch`, `actions/harness-render-prompt`,
`actions/harness-prompt-context`) are released by the GitHub Actions **Release actions** workflow.
Each run creates one annotated `vX.Y.Z` tag on the current `main` commit and publishes a GitHub
Release for it. No commit is made.

Consumers still pin a full commit SHA, never a tag or branch. The tag exists so the pin can carry a
plain `# vX.Y.Z` version comment. Repositories that enforce `owner/repo@<40-char-sha> # vX.Y.Z`
pins, and Dependabot's `github-actions` updater, both read that comment:

```yaml
- uses: jonathanong/auto-harness/actions/harness-render-prompt@<sha of vX.Y.Z> # vX.Y.Z
```

The `vX.Y.Z` line is independent of the npm client's `client-vX.Y.Z` tags ([release-client.md](release-client.md)).
Client tags cannot be used as pin comments. They are not plain semver, and the client's `0.x`
numbers sort below the `v1` actions line, so Dependabot would propose a downgrade.

## Prerequisites

The repository Actions secret `RELEASE_TOKEN` can push tags and create releases. It is the same
secret **Release client** uses.

## Publish

1. Confirm the intended Action changes are on `main` and its required CI checks passed.
2. In GitHub Actions, open **Release actions**, select **Run workflow**, keep the branch set to
   `main`, and choose `patch`, `minor`, or `major`. From a shell:
   `gh workflow run release-actions.yml --ref main -f release_type=patch`.
3. The workflow finds the highest `vX.Y.Z` tag reachable from `main`, increments it, tags the
   fetched `main` head, pushes only that tag, and creates the GitHub Release. The Release is not
   marked latest, which leaves that marker on the client release.
4. Update consumer pins to the tag's commit SHA with the matching `# vX.Y.Z` comment.

The run fails without tagging when the `main` head already carries a `vX.Y.Z` tag, or when the
next tag already exists.

## Retry and recovery

- If a run fails before pushing its tag, rerun it.
- If the tag was pushed but GitHub Release creation failed, rerun the same run. It finds the tag
  whose annotation names that run and only creates or verifies the Release, even if `main` has
  moved on.
- Do not delete or move a release tag. Start a fresh dispatch when another version is intended.
