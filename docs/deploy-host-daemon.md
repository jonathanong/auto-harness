# Deploy — VPS agent

Agent host: trusted machine that holds git + AI credentials and runs non-interactive CLIs. Security: [security.md](security.md). Internals: [host-daemon.md](host-daemon.md). CLI: [cli.md](cli.md).

Ops index: [deploy.md](deploy.md). Local stack: [deploy-local.md](deploy-local.md). AWS control plane: [deploy-aws.md](deploy-aws.md).

---

## Maturity

| Item                                     | Status                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Local daemon (`pnpm local:daemon start`) | **Supported** against local API/WS                                                                               |
| `pnpm local:daemon install-service`      | **Supported** — systemd (linux), LaunchAgent (macOS, current user), logon scheduled task (Windows, current user) |
| Production systemd unit                  | **Packaged** — checked-in unit and environment contract; syntax and graceful drain are validated in CI           |
| Drain without killing in-flight CLIs     | **Implemented** in control plane / agent loop ([host-daemon.md](host-daemon.md#auto-update-graceful-restart))    |
| Signed update orchestration core         | **Implemented and locally tested** behind injected fetch/install/restart boundaries                              |
| Automatic production download / restart  | **Supported when explicitly configured** with a signed manifest and a stable platform supervisor launcher        |

---

## Prerequisites

- Node ≥ 22.18, Git 2.36+
- Target AI CLIs on `PATH` (`grok`, `codex`, …) for real profiles
- Control plane reachable (local [deploy-local.md](deploy-local.md) or AWS [deploy-aws.md](deploy-aws.md))
- Bound service-account API key when talking to a secured control plane ([auth.md](auth.md#vps-agent-authentication))

At startup the daemon runs `git --version` before advertising capacity. A host with Git older than
2.36, an unavailable Git executable, or unrecognizable version output remains connected for
diagnosis but is not schedulable; upgrade or repair Git rather than weakening checkout recovery.

The service does not implicitly start a login shell or source `.zshrc`/`.bashrc`. If a host needs
shell-managed PATH entries or exported provider prerequisites, opt in with the host inventory's
root `setupScript` (for example `source "$HOME/.zshrc"`); a host/repository attachment may add its
own setup. See [host-daemon.md](host-daemon.md#setup-scripts).

---

## Deploy (install)

### One-command path (supported)

Identity is still env-only (`HARNESS_HOST_ID`, `HARNESS_API_URL` as the CloudFront
`WebUrl` on AWS, `HARNESS_API_KEY` as the bound key). From the checkout, the same
command persists the daemon on every supported OS:

```bash
export HARNESS_HOST_ID='<bound-host-id>'
export HARNESS_API_URL='https://d111111abcdef8.cloudfront.net'  # CloudFront WebUrl
export HARNESS_API_KEY='hns_…'
pnpm local:daemon install-service
```

Every platform validates the effective persisted env before writing service files or restarting.
It requires a non-placeholder bound `HARNESS_HOST_ID`, a well-formed non-local HTTPS production
`HARNESS_API_URL`, a non-placeholder `HARNESS_API_KEY`, and—when configured—an integer
`HARNESS_MAX_CONCURRENT_ASSIGNMENTS` from 1 through 256. `status` / `run-session` / `start` keep the
local defaults. If a deployed URL changes, update only the non-secret URL while retaining the
persisted bound key:

```bash
pnpm local:daemon install-service --api-url 'https://new-control.example.com'
```

The update path rewrites only `HARNESS_API_URL` and validates the resulting file before writing or
restarting; it never prints or requires copying `HARNESS_API_KEY`. On Linux, run the update as root
when the existing mode-0600 env file is root-owned.

After installation, point the interactive CLI at the persisted service environment when checking
the deployed daemon. The CLI deliberately keeps its `local-1` / `http://127.0.0.1:7420` defaults
unless `HARNESS_ENV_FILE` or the identity variables are supplied; a plain `pnpm local:daemon status`
therefore checks the local-development identity, not the installed production identity. On macOS:

```bash
env -u HARNESS_HOST_ID -u HARNESS_API_URL -u HARNESS_API_HTTP -u HARNESS_API_KEY \
  HARNESS_ENV_FILE="$HOME/Library/Application Support/auto-harness/host-daemon.env" \
  pnpm local:daemon status
```

The `env -u` options matter when the shell has stale local-development or other host credentials:
explicit, nonempty environment variables take precedence over values loaded from the file.
The command succeeds only when the LaunchAgent is running and the exact persisted host is online,
non-draining, and explicitly Git-ready. Use `status --config-only` when you only need the configured
inventory. Status output is bounded and never includes the persisted API key or raw service-manager
diagnostics. Do not print the environment file: it contains the bound service-account key.

| OS      | What it installs                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Linux   | systemd unit `auto-harness-host-daemon.service` as user `harness`                                                           |
| macOS   | LaunchAgent `~/Library/LaunchAgents/com.auto-harness.host-daemon.plist` as the **current user** (`HOME` kept for CLI creds) |
| Windows | Logon scheduled task as the **current user** (not `LOCALSYSTEM`)                                                            |

Env files are mode `0600` and are never committed:

- Linux: `/etc/auto-harness/host-daemon.env` (created from the checked-in example if missing)
- macOS: `~/Library/Application Support/auto-harness/host-daemon.env`
- Windows: `%APPDATA%\auto-harness\host-daemon.env`

On Linux, if this command is not root and no service environment exists yet, it writes a staged
unit/env and prints:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now auto-harness-host-daemon.service
```

If `/etc/auto-harness/host-daemon.env` already exists, rerun `install-service` with `sudo`; the
installer refuses to stage around a root-owned file that it cannot safely read and validate.

The generated Linux launcher and its update-promotion helper are root-owned under
`/usr/local/lib/auto-harness/`. The helper is run by systemd before each daemon start: it
independently verifies the signed staged artifact, extracts it into a root-owned release tree,
and atomically switches `current`. The daemon (and every session CLI it starts) can write only
the private `incoming/` request directory; it cannot modify `current` or runnable releases. The
Linux default keeps that immutable update root at `/opt/auto-harness`, separate from its writable
deployment staging checkout at `/opt/auto-harness/staging`. When run with
`sudo`, `install-service` also locks a legacy `current -> versions/<version>` target before
enabling the unit.
`KillMode`, `TimeoutStopSec`, and `Type=notify` stay as in the checked-in unit. The daemon sends
systemd `READY=1` only after it has registered with the control plane; that readiness barrier lets
the root-owned post-start helper confirm a promoted release only after the replacement is usable.

Uninstall (removes the service definition, not the checkout):

```bash
pnpm local:daemon uninstall-service
```

### VPS install path

Keep this when you are installing onto a dedicated Linux VPS by hand (create the
`harness` user, clone into `/opt/auto-harness/staging`, then install the service). The
one-command path above is the supported operator path for an already-cloned
checkout.

On the agent host:

1. Install Node, Git, and AI CLIs.
2. Create a dedicated user and install the monorepo checkout in the writable staging path:

   ```bash
   sudo useradd --create-home --shell /usr/sbin/nologin harness
   sudo install -d -o root -g root -m 0755 /opt/auto-harness
   sudo install -d -o harness -g harness -m 0700 /opt/auto-harness/staging
   sudo -u harness git clone https://YOUR_GIT_REMOTE/auto-harness.git /opt/auto-harness/staging
   sudo -u harness env CI=true corepack pnpm --dir /opt/auto-harness/staging install --prod --frozen-lockfile
   ```

   The checked-in package uses Node's native TypeScript execution, so deploy the complete checkout and
   workspace dependencies. It is not a standalone compiled binary or npm tarball.

3. Create a **bound** service account on the control plane (`boundHostId` = this host’s `hostId`).
4. **Configure host inventory via API/UI** (not a local file): absolute repo/worktree paths, plus which catalog Provider Accounts are attached to this host. Commands resolve to named, fixed argv (D4 — no free-form shell) from the global Provider/Provider Account/Command catalogs, not a per-host profile map.
5. Set daemon identity/runtime values and only explicitly allowlisted child credentials on the host.
   Inventory remains in the control plane, not this file:

| Variable                      | Role                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HARNESS_HOST_ID`             | Required agent id                                                                                                                                                                                                                                                                                                                                                                                                  |
| `HARNESS_API_URL`             | Control plane base — the CloudFront `WebUrl` from the deploy output ([deploy-aws.md](deploy-aws.md#stack-parameters-and-outputs)) on AWS, or `http://127.0.0.1:7420` locally. **Never** a raw `RestApiUrl`/`WebSocketUrl` `*.execute-api.*.amazonaws.com` value — see [aws.md](aws.md#websocket-wss)                                                                                                               |
| `HARNESS_API_KEY`             | Service account `hns_…`                                                                                                                                                                                                                                                                                                                                                                                            |
| `HARNESS_CHILD_ENV_ALLOWLIST` | Optional comma-separated non-`HARNESS_*` names to forward to repository commands (for example `GITHUB_TOKEN`). Every listed name must also be defined in the persisted service environment; installation and daemon startup reject malformed, reserved, duplicate, or undefined names without printing their values. Empty defined values are allowed.                                                             |
| `HARNESS_UPDATE_MANIFEST_URL` | Optional HTTPS signed-update manifest. Set this and `HARNESS_UPDATE_PUBLIC_KEY` together to enable updates.                                                                                                                                                                                                                                                                                                        |
| `HARNESS_UPDATE_PUBLIC_KEY`   | Ed25519 PEM used to verify the update manifest. In an EnvironmentFile, encode line breaks as literal `\\n`.                                                                                                                                                                                                                                                                                                        |
| `HARNESS_UPDATE_INSTALL_DIR`  | Optional persistent signed-update root. It must be an absolute path on every platform. On Linux it defaults to `/opt/auto-harness`; every path component through a custom root must be a root-owned, non-writable, non-symlink directory. Its `current`/`releases` contents stay root-owned while only `incoming` is writable by `harness`. The writable deployment checkout is `staging/` beneath that same root. |
| `HARNESS_UPDATE_POLL_MS`      | Optional integer poll interval in milliseconds. `0` checks once on startup; the maximum is `2147483647` (Node's largest timer delay).                                                                                                                                                                                                                                                                              |
| `HARNESS_DAEMON_VERSION`      | Optional fallback current version before an activated `current` tree supplies its persisted marker.                                                                                                                                                                                                                                                                                                                |

The Host Advanced **Host daemon updates** form accepts a normal multiline PEM and stores its line
breaks as literal `\n`, so the same setting remains valid when `install-service` writes the
single-line service EnvironmentFile. API and host-config inputs receive the same normalization.

For a managed Host, configure these as structured **Host daemon updates** controls on the
control-plane Host’s Advanced tab. Those settings are authenticated, audited, and take precedence
over legacy service-environment values. After saving, rerun `install-service` on that Host so the
root-owned systemd promotion helper and the daemon agree on the selected install directory; then
restart the Host daemon. Leaving the control-plane setting absent retains the local environment as
the compatibility fallback, while an explicit disabled setting overrides an existing local update
configuration.

If the CloudFront WebSocket hop ever needs to be bypassed (deploy-day diagnosis only, not a
supported steady-state configuration), add `--ws wss://<WebSocketUrl>` to this unit's
`ExecStart` in `auto-harness-host-daemon.service`. That flag overrides only the WebSocket
target and accepts the raw API Gateway endpoint directly; REST still resolves from
`HARNESS_API_URL`, which must stay set to `WebUrl`.

6. Install the environment file. Populate it before starting; never commit it:

```bash
UPDATE_ROOT=/opt/auto-harness # set to the same value as HARNESS_UPDATE_INSTALL_DIR when customized
STAGING_ROOT="$UPDATE_ROOT/staging"
sudo install -d -m 0755 /etc/auto-harness
sudo install -m 0600 \
  "$STAGING_ROOT/services/host-daemon/systemd/host-daemon.env.example" \
  /etc/auto-harness/host-daemon.env
sudoedit /etc/auto-harness/host-daemon.env
cd "$STAGING_ROOT"
sudo env "PATH=$PATH" "$(command -v pnpm)" local:daemon install-service
```

The installer creates the root-owned unit, stable launcher, promotion helper, and immutable
`current`/`releases` layout. On a first install, its generated launcher runs the staging checkout
only as the unprivileged `harness` service user until the configured signed updater promotes an
immutable `current` release; subsequent starts select only `current`. `TimeoutStopSec=15min` plus
`KillMode=mixed` lets the daemon durably enter drain and wait for in-flight CLIs instead of having
systemd kill the whole cgroup. An operator can still use an explicit `systemctl kill
--kill-who=all --signal=SIGKILL auto-harness-host-daemon.service` for an acknowledged emergency;
that is not the normal update path.

The bound is finite on purpose. It was `infinity`, and the daemon had no bound of its own:
with the control plane unreachable, `beginDrain()` retried its announcement forever and
never settled, so `systemctl stop` hung indefinitely even with no session in flight. The
daemon now stops announcing after `drainDeadlineMs` (30s) and forces exit after
`HARNESS_SHUTDOWN_TIMEOUT_MS` (default 10min), with this unit as the outer backstop.

The service is `Type=notify` with `NotifyAccess=main`: after control-plane registration, the main
daemon process sends `sd_notify READY=1` with a `registered` status. `systemctl status` is therefore
an initial registration-readiness check, while host online/keepalive state in the control plane
remains the continuous readiness signal. The unit does not implement a systemd watchdog or reload
protocol; do not add `WatchdogSec` or `ExecReload` without implementing their daemon protocols.

7. Confirm the service and control-plane registration:

```bash
sudo systemctl status auto-harness-host-daemon.service
sudo journalctl -u auto-harness-host-daemon.service -n 100 --no-pager
sudo env HARNESS_ENV_FILE=/etc/auto-harness/host-daemon.env node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";

const entries = new Map(
  readFileSync(process.env.HARNESS_ENV_FILE, "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const hostId = entries.get("HARNESS_HOST_ID");
const apiKey = entries.get("HARNESS_API_KEY");
let base = entries.get("HARNESS_API_URL")?.replace(/\/$/, "").replace(/\/ws$/, "");
if (!hostId || !apiKey || !base) throw new Error("host id, API URL, and API key are required");
base = base.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
const headers = { authorization: `Bearer ${apiKey}` };
for (const path of [
  "/api/v1/hosts",
  `/api/v1/hosts/${encodeURIComponent(hostId)}/inventory`,
  "/api/v1/session-targets",
]) {
  const response = await fetch(`${base}${path}`, { headers });
  console.log(path, response.status, await response.text());
  if (!response.ok) process.exitCode = 1;
}
NODE
```

Credentials and prerequisites needed by every session must be persisted in this environment file
and named in `HARNESS_CHILD_ENV_ALLOWLIST`. Setup-script exports apply only to fresh sessions because
native resumes deliberately skip setup scripts. For example, Filaments Blackboard integration should
persist and allowlist both `AGENT_BLACKBOARD_URL` and `AGENT_BLACKBOARD_TOKEN` before restarting the
daemon.

The verifier reads the root-only environment file without echoing its API key, tolerates a
`ws(s)://…/ws`-shaped value even though `HARNESS_API_URL` is expected to be the plain
`https://` `WebUrl`, and authenticates every request. Keep the installed file in the example's
unquoted `KEY=value` form; systemd environment files are not shell scripts.

Host inventory template: [examples/local/host-inventory.config.json](../examples/local/host-inventory.config.json). Runbooks: [local-development.md](local-development.md), [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md).

---

## Update

### Agent binary / package

After `pnpm deploy:aws`, update and verify the persisted service on this host with the second
top-level command:

```bash
pnpm deploy:host
```

It installs the lockfile with package lifecycle scripts disabled, then explicitly rebuilds only the
locked `node-pty` package. That package-owned rebuild uses a prebuilt binary when available and its
trusted `node-gyp` source-build fallback on Linux before the platform installer (which gracefully
drains during restart). It loads the platform's persisted service environment and polls for up to
two minutes until the exact host is online, non-draining, and Git-ready; the same end-to-end
deadline terminates an in-flight status process group instead of waiting indefinitely. It also
requires the clean `main` revision already synced by `pnpm deploy:aws`. On Linux, run it as the
checkout owner from `/opt/auto-harness/staging` whenever that conventional staging checkout
exists; the wrapper refuses to validate a different staging directory. It invokes `sudo` only for
the systemd installer and verification so Git and dependency files retain the right ownership. The
service runs only its immutable `current` release: when signed updates are configured, its immediate
updater poll writes the verified artifact into `incoming/` and systemd's root-owned helper promotes
it. The manual procedure below remains the recovery path for immutable revisions, rollbacks, and
dedicated VPS checkouts. For a custom `HARNESS_UPDATE_INSTALL_DIR`, export that same absolute path
before invoking `pnpm deploy:host`, so the wrapper validates its corresponding `staging/` checkout.

Current path — an operator must **drain, deploy, then restart** ([host-daemon.md](host-daemon.md#auto-update-graceful-restart)):

1. Signal drain:
   - Control plane: `POST /api/v1/hosts/drain` with `{ "hostId": "…" }`
   - And/or agent-local drain signal
2. Wait until no running sessions on that agent.
3. Fetch and check out the new staging revision, then install its locked production dependencies:

   ```bash
   sudo -u harness git -C /opt/auto-harness/staging fetch --all --tags
   sudo -u harness git -C /opt/auto-harness/staging checkout NEW_IMMUTABLE_REVISION
   sudo -u harness env CI=true corepack pnpm --dir /opt/auto-harness/staging install --prod --frozen-lockfile
   cd /opt/auto-harness/staging
   pnpm deploy:host
   ```

4. Verify the signed promotion/restart registered the host:

   ```bash
   sudo systemctl status auto-harness-host-daemon.service
   ```

5. Confirm re-register and capacity restored (`draining` cleared).

On a macOS host installed as a LaunchAgent, perform the same drain-and-wait boundary, then update
the checkout as the current user. Re-running `install-service` keeps the existing mode-0600
environment file, rewrites a stable launcher under `~/Library/Application Support/auto-harness`,
and reloads the LaunchAgent. The plist always starts that launcher; it selects the activated
`current` tree when present and otherwise falls back to the installation checkout. After
`bootout`/`bootstrap`, a stopped job is started with `launchctl kickstart -k` and verified as a
running process with a PID. Exit 37 / "already in progress" is an error, not restart success.

```bash
git fetch --all --tags
git checkout NEW_IMMUTABLE_REVISION
CI=true corepack pnpm install --frozen-lockfile
pnpm local:daemon install-service

env -u HARNESS_HOST_ID -u HARNESS_API_URL -u HARNESS_API_HTTP -u HARNESS_API_KEY \
  HARNESS_ENV_FILE="$HOME/Library/Application Support/auto-harness/host-daemon.env" \
  pnpm local:daemon status
```

Run these commands from the checkout that the LaunchAgent should execute. No `sudo` is required.
If `status` reports `hostId: "local-1"`, the status process did not load the persisted environment;
the LaunchAgent may still be running correctly, but that result does not verify the deployed host.

Do **not** kill in-flight AI CLIs for routine upgrades.

`AgentUpdater` implements the ordered state machine for a signed Ed25519 manifest: compare version,
durably drain, wait for idle, fetch and SHA-256 verify the artifact, stage, activate, request
supervisor restart, and roll back plus resume scheduling if activation or restart fails. Activation
also writes a durable pending-boot marker before switching `current`. On macOS and Windows, the
stable launcher records that first boot _before it selects the activated module_; on Linux,
systemd's root-owned pre-start helper does the equivalent work. A registered replacement clears the
marker only after the control plane accepts it. If that replacement crashes before acknowledgement
(including before its module reaches `main`), its next supervisor launch rolls `current` back to
the saved release through the stable launcher. Obsolete
release trees are pruned only after that acknowledgement. Concurrent runs collapse into one update. Set `HARNESS_UPDATE_MANIFEST_URL` (https),
`HARNESS_UPDATE_PUBLIC_KEY` (Ed25519 PEM; use literal `\\n` in a single-line EnvironmentFile),
optional absolute `HARNESS_UPDATE_INSTALL_DIR` (defaults: `/opt/auto-harness` on Linux,
`~/Library/Application Support/auto-harness/updates` on macOS, and
`%APPDATA%\\auto-harness\\updates` on Windows), and optional `HARNESS_UPDATE_POLL_MS` (`0` = once
per start; maximum `2147483647`) to enable the
production HTTPS fetch, filesystem install, and systemd/launchd/schtasks restart adapters. On
Linux, the checked-in manual unit uses a stable wrapper outside the activated tree; that wrapper
reads the persisted `HARNESS_UPDATE_INSTALL_DIR`, so set `UPDATE_ROOT` above to the same path when
using a non-default root. The
artifact is a gzip-compressed tar archive whose root is a complete runnable checkout (including
`package.json` and the host-daemon launcher). On Linux, the unprivileged daemon writes the
already-verified artifact and manifest only to `incoming/`; systemd's root-owned pre-start helper
verifies both again, extracts the release below root-owned `releases/`, and atomically switches
`current`. Linux then requests an asynchronous self-exit after the updater transaction; its
already-authorized systemd supervisor restarts it, rather than the unprivileged service user
invoking `systemctl`. macOS and Windows supervisors invoke stable
launcher files outside the activated tree, so their next start resolves the new `current` pointer.
On Windows, a detached handoff owns the scheduled task's stop/start sequence rather than asking
the running daemon to terminate its own task before it can request the replacement.
On Linux, the selected update root, `current`, and `releases/` must remain root-owned; only
`incoming/` is writable by `harness`. The writable deployment checkout is `staging/` below the
same root and is never selected as an active release once `current` exists. Both stable launcher
and promotion helper are root-owned and are never replaced by the updater.
Without the signed-manifest settings, the service continues the last activated
release; `pnpm deploy:host` still refreshes only the writable staging checkout
and root-owned service files. Configure a signed manifest and public key before
using the normal Linux deployment path to activate a new release.

### Rollback

Use the same drain boundary, select the previously verified signed release in the manifest, then
restart so the updater stages it to `incoming/` for the root-owned helper to promote. To refresh the
writable staging checkout for future deployments:

```bash
sudo -u harness git -C /opt/auto-harness/staging checkout PREVIOUS_IMMUTABLE_REVISION
sudo -u harness env CI=true corepack pnpm --dir /opt/auto-harness/staging install --prod --frozen-lockfile
cd /opt/auto-harness/staging
pnpm deploy:host
```

Then confirm the host re-registers and run one smoke session. Rollback does not bypass schema or
control-plane compatibility requirements; roll the control plane first when the versions require it.

### Command profiles / repos

- Update host inventory via `PUT /api/v1/hosts/:hostId/inventory` or the Agents UI.
- Restart agent after drain so it re-bootstraps the new inventory.
- Keep profile names stable when possible so schedules/UI selections keep working.

### Relation to control plane updates

When the **API** changes: roll control plane first ([deploy-aws.md](deploy-aws.md) / [deploy-local.md](deploy-local.md)), then roll agents with this drain path.

---

## Teardown

1. Drain agent; wait for idle.
2. Stop and disable the persisted service:

   ```bash
   pnpm local:daemon uninstall-service
   ```

   Linux VPS copy-unit path (SIGTERM follows the same graceful drain path):

   ```bash
   sudo systemctl disable --now auto-harness-host-daemon.service
   sudo rm /etc/systemd/system/auto-harness-host-daemon.service
   sudo systemctl daemon-reload
   ```

3. Remove `/etc/auto-harness/host-daemon.env`. Optionally remove the checkout and worktrees only
   after separately confirming their exact paths and backup policy.
4. Delete or rotate the service-account API key on the control plane.
5. Confirm `GET /api/v1/hosts` no longer lists the agent as online.

---

## Gates

| When                       | Gate                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| After agent install/update | Online in `/hosts`, expected profiles, one smoke session                                                 |
| After hard kill / crash    | Re-register; reconcile running sessions ([host-daemon.md](host-daemon.md#disconnect-and-crash-recovery)) |

The repository validates the unit contract and generated LaunchAgent/scheduled-task templates with
`pnpm check:systemd`, uses `systemd-analyze verify` when it is available, and runs the packaged
entrypoint against a real local HTTP/WebSocket control plane while SIGTERM arrives during an active
CLI. These are packaging and process-lifecycle proofs; they do not claim that CI installed, enabled,
stopped, or restarted a service on a production host.

---

## Related

| Doc                                | Role                       |
| ---------------------------------- | -------------------------- |
| [deploy.md](deploy.md)             | Ops index                  |
| [deploy-local.md](deploy-local.md) | Local control plane        |
| [deploy-aws.md](deploy-aws.md)     | AWS control plane          |
| [host-daemon.md](host-daemon.md)   | Drain / recovery internals |
| [cli.md](cli.md)                   | Agent CLI                  |
| [auth.md](auth.md)                 | Bound API keys             |
| [security.md](security.md)         | Host hardening             |
