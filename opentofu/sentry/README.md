# Auto Harness Sentry stack

This is an independent, optional OpenTofu root for the Auto Harness Sentry
projects. It is intentionally outside the Vouchington infrastructure root and
does not manage AWS, GitHub repositories, the existing Sentry platform team, or
the existing `jonathanong` GitHub integration.

It creates exactly four projects, each with separate staging and production
client keys:

- `auto-harness-control-plane-lambda` (`node-awslambda`)
- `auto-harness-control-plane-web` (`javascript-nextjs`)
- `auto-harness-host-plane-backend` (`node`)
- `auto-harness-host-plane-web` (`javascript-nextjs`)

Projects and keys have `prevent_destroy`; default keys and default issue rules
are disabled. Public DSNs are exposed only through the
`public_dsn_by_environment` output. The OpenTofu backend is deliberately
unconfigured: provide the approved remote backend settings with
`tofu init -backend-config=...`.

## Operator flow

```sh
cd opentofu/sentry
tofu init -backend-config=backend.hcl
SENTRY_AUTH_TOKEN=... tofu plan -out=sentry.tfplan
# Review the saved plan and authorize this exact file before applying it.
SENTRY_AUTH_TOKEN=... tofu apply sentry.tfplan
```

The repository does not run `tofu apply` automatically. Render runtime DSN
exports only after an operator has applied the saved plan:

```sh
HARNESS_DEPLOY_ENVIRONMENT=production \
  HARNESS_SENTRY_TOFU_DIR="$PWD" \
  node ../../scripts/sentry-dsn-sync.ts
```

Sentry is off by default. For a standalone local production build, upload maps
with the explicit helper and a 40-character Git SHA as the release:

```sh
cd ../..
HARNESS_SENTRY_RELEASE="$(git rev-parse HEAD)" \
HARNESS_SENTRY_UPLOAD_TOKEN=... \
pnpm sentry:sourcemaps web
HARNESS_SENTRY_RELEASE="$(git rev-parse HEAD)" \
HARNESS_SENTRY_UPLOAD_TOKEN=... \
pnpm sentry:sourcemaps host-pane
```

The helper exposes the upload token only to the short-lived Next production
build. The Sentry plugin uploads and deletes the maps before the build returns;
the token is not forwarded to the resulting server, Lambda, host daemon,
repository commands, or logs. With `HARNESS_SENTRY_ENABLED=1`, `pnpm deploy:aws`
does the same upload inside the exact Docker image build using a BuildKit secret
and the deployed Git SHA as the release. Upload failure stops deployment. The
host-pane helper prepares that local production artifact but does not install or
restart a host-pane service.
