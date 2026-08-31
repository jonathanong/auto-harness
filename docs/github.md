# GitHub automation

Dependabot version updates, pull-request labels, and workflow lint. Required CI remains
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml); client publishing is
[release-client.md](release-client.md).

## Dependabot

[`.github/dependabot.yml`](../.github/dependabot.yml) opens weekly version-update pull requests for:

| Ecosystem        | What it watches                              |
| ---------------- | -------------------------------------------- |
| `npm`            | The pnpm workspace lockfile at the repo root |
| `github-actions` | SHA-pinned actions in `.github/workflows`    |
| `docker`         | `services/web/Dockerfile.aws`                |
| `docker-compose` | `docker-compose.yml` (DynamoDB Local)        |

Minor and patch version bumps are grouped (production vs development for npm). Major bumps stay
one dependency per pull request. Security updates stay enabled in repository settings and are not
grouped.

`next`, `react`, and `react-dom` live in the default pnpm catalog (`pnpm-workspace.yaml`).
Workspace packages reference them as `catalog:` so a grouped npm bump cannot leave
`@auto-harness/ui` on a different Next than the apps. `scripts/ui-runtime-catalog.test.ts`
rejects a split lockfile snapshot.

`node-pty` is listed in `pnpm-workspace.yaml` `patchedDependencies`. Dependabot will not open
ordinary version PRs for it; a security advisory still can. Refresh `patches/node-pty@*.patch`
before landing any `node-pty` bump.

## Pull request labels

[`.github/labeler.yml`](../.github/labeler.yml) maps changed paths to `area/*` labels plus
`documentation`. [`.github/workflows/labeler.yml`](../.github/workflows/labeler.yml) applies them on
pull requests against `main` and creates a missing label when needed.

## actionlint

[`.github/workflows/actionlint.yml`](../.github/workflows/actionlint.yml) downloads a checksummed
[actionlint](https://github.com/rhysd/actionlint) release and lints every workflow. Configuration
variables used in CI are allow-listed in [`.github/actionlint.yaml`](../.github/actionlint.yaml).

Locally:

```bash
brew install actionlint
actionlint
```

Add the `actionlint` check to branch protection if you want it required alongside CI.
