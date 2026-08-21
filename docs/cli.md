# CLI

Phase 1 local tooling for the agent and API packages. CI callers use the [REST API](api.md) (fire-and-forget); they do not run this CLI.

Full local runbook: [local-development.md](local-development.md). Pre-deploy E2E: [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md).

## Invocation (from monorepo root)

```bash
pnpm install

# Local API first (DynamoDB Local)
pnpm local:dynamodb && pnpm local:dynamodb:ready
pnpm local:api
# → http://127.0.0.1:7420

# Configure host inventory (repos/worktrees) via API — not a local file
curl -fsS -X PUT "http://127.0.0.1:7420/api/v1/hosts/local-1/inventory" \
  -H 'content-type: application/json' \
  -d @examples/local/host-inventory.config.json

# A session/schedule targets a Provider or Command from the global catalog, not the host
# config. A Provider target uses its healthy attached account pool; a providerless Command
# is a pure CLI target. Create a command before creating a session:
curl -fsS -X POST "http://127.0.0.1:7420/api/v1/commands" \
  -H 'content-type: application/json' \
  -d '{"name":"echo-prompt","argv":["echo"],"appendPrompt":true,"providerId":null}'

# Agent: identity via env only
export HARNESS_HOST_ID=local-1
export HARNESS_API_URL=http://127.0.0.1:7420
pnpm local:daemon status
pnpm local:daemon run-session --file /path/to/session.assign.json

# One-shot create→run verification
pnpm local:e2e
# Documented CLI path (requires local:api)
pnpm local:cli-e2e
```

Agent process env: `HARNESS_HOST_ID`, `HARNESS_API_URL`, optional `HARNESS_API_KEY`.

---

## Agent commands (Phase 1)

### `status`

The default status is a bounded readiness check with three separately labelled sections:
local service-manager state, the exact host's control-plane liveness/draining/readiness,
and configured inventory. It exits `0` only when the service is running and the exact host
is online, non-draining, and explicitly Git-ready. Missing or legacy readiness data fails
closed. API keys and service-manager command output are never printed.

```bash
export HARNESS_HOST_ID=local-1 HARNESS_API_URL=http://127.0.0.1:7420
pnpm local:daemon -- status
```

Use `status --config-only` for the prior inventory-only JSON (`hostId`, `repositories`,
and worktrees) and its configuration-only exit behavior. This mode does not query the
service manager or control-plane host status.

### `run-session`

Run one session from a JSON assign file (see [examples/local/session.assign.json](../examples/local/session.assign.json)).

```bash
pnpm local:daemon -- run-session --file ./session.assign.json
```

Required assign fields: `sessionId`, `repositoryId`, `prompt`, `resolvedArgv` (the already-resolved argv — this is the same wire shape the control plane sends over `session:assign`, computed control-plane-side from a Provider Account/Command; the agent never resolves a target itself), `timeout` (seconds), `worktreeId`. Optional: `ref`, `setupScript`, `resume`, `resumedFromSessionId`, `cliResumeRef`, `resumeRefCapture`, `metadata`. Resume re-checks out `ref` when supplied (otherwise the repository default branch) and skips setup.

Terminal line is JSON: `{ "status", "exitCode", "errorCode" }`. Exit code `0` only when `status === "completed"`.

### `start`

WebSocket daemon: bootstrap config → register → accept assigns.

```bash
pnpm local:daemon start
# optional: --ws ws://127.0.0.1:7420/ws  (otherwise derived from HARNESS_API_URL)
```

### `install-service` / `uninstall-service`

Persist this checkout's daemon so it survives logout/reboot: systemd on Linux (user `harness`),
a LaunchAgent as the current user on macOS (`HOME` kept for CLI creds), or a logon scheduled
task as the current user on Windows (not `LOCALSYSTEM`). Identity is read from `HARNESS_*` and
written to a mode-0600 env file that is never committed.

Every platform validates the effective persisted env before writing service files or restarting:
use a bound, non-placeholder host id, a non-local HTTPS production URL, and a bound key (same
recipe as [deploy-host-daemon.md](deploy-host-daemon.md)):

```bash
export HARNESS_HOST_ID='<bound-host-id>'
export HARNESS_API_URL='https://d111111abcdef8.cloudfront.net'  # CloudFront WebUrl
export HARNESS_API_KEY='hns_…'
pnpm local:daemon install-service
pnpm local:daemon uninstall-service
```

To change a deployed control-plane URL without copying the persisted secret key, pass the
non-secret replacement explicitly. Only `HARNESS_API_URL` is rewritten, and the resulting env
file is validated before the service is restarted:

```bash
pnpm local:daemon install-service --api-url 'https://new-control.example.com'
```

`status` / `run-session` / `start` still default to `local-1` and `http://127.0.0.1:7420` for
local work above. On a deployed host, run `status` with the same persisted identity used by
the service; it queries only that `hostId` and sends the API key as an authorization header.

Host install details: [deploy-host-daemon.md](deploy-host-daemon.md).

---

## API commands (Phase 1)

### `serve`

```bash
pnpm local:api
# optional: node services/api/src/cli.ts serve --port 7420
```

| Method | Path                   | Notes                                                                                                                                                                            |
| ------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`              | `{ ok: true }`                                                                                                                                                                   |
| `POST` | `/api/v1/sessions`     | body: `repositoryId`, `prompt`, `target`, optional ordered `fallbacks` and `queueTtlSeconds`, `timeout` (+ optional `ref`, labels, …) → `201` with `id`, `status: queued`, `url` |
| `GET`  | `/api/v1/sessions`     | list                                                                                                                                                                             |
| `GET`  | `/api/v1/sessions/:id` | get                                                                                                                                                                              |

No auto-dispatch to the agent yet — bridge with a session assign file for `run-session`.

---

## Host inventory (API/UI)

Repositories, worktrees, and which Provider Accounts (plus their per-repo/per-worktree enable/command overrides) are available on this host. Each attached `providerAccountId` must already exist in the catalog.

```bash
PUT /api/v1/hosts/:hostId/inventory
GET /api/v1/hosts/:hostId/inventory
GET /api/v1/host-inventories
```

```json
{
  "providerAccounts": [{ "providerAccountId": "acct-1" }],
  "repositories": [
    {
      "id": "demo",
      "path": "/abs/path/to/repo",
      "defaultBranch": "main",
      "terminalHookScript": "/abs/path/hook.sh",
      "worktrees": [
        {
          "id": "wt-1",
          "name": "wt-1",
          "path": "/abs/path/to/repo/.worktrees/wt-1",
          "labels": ["echo"]
        }
      ]
    }
  ]
}
```

What a session actually runs is **named, fixed argv** (D4), resolved from the global
Provider/Provider Account/Command catalogs, not from this document — the document above no
longer carries a `commandProfiles` field at all (removed; it never resolved anything once
D4 landed):

```bash
POST /api/v1/providers            # {name} — creates the provider AND its default command
POST /api/v1/provider-accounts    # {providerId, label}
POST /api/v1/commands             # {name, argv, appendPrompt, providerId} — providerId: null for standalone
GET  /api/v1/session-targets      # unified picker: Providers + Commands (including providerless)
```

`POST /api/v1/sessions`/`schedules` take a `target` and ordered `fallbacks`: `{ providerId }`
uses that provider's healthy attached account pool; `{ commandId }` uses that exact command,
with its provider pool when provider-owned; and a command whose `providerId` is `null` is a
providerless pure CLI that runs ungated. An unknown id is rejected at create time; free-form
command strings are never accepted. Provider Account cooldowns default to 5 hours and queued
sessions expire after 8 days unless `queueTtlSeconds` is set. A usage limit pauses the assigned
account globally and immediately advances the route; ordinary failures remain terminal.

Template: [examples/local/host-inventory.config.json](../examples/local/host-inventory.config.json). Or use the Hosts page in the local web UI.
