# Deploy — VPS agent

Agent host: trusted machine that holds git + AI credentials and runs non-interactive CLIs. Security: [security.md](security.md). Internals: [host-daemon.md](host-daemon.md). CLI: [cli.md](cli.md).

Ops index: [deploy.md](deploy.md). Local stack: [deploy-local.md](deploy-local.md). AWS control plane: [deploy-aws.md](deploy-aws.md).

---

## Maturity

| Item                                     | Status                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Local daemon (`pnpm local:daemon start`) | **Supported** against local API/WS                                                                            |
| Production systemd unit                  | **Packaged** — checked-in unit and environment contract; syntax and graceful drain are validated in CI        |
| Drain without killing in-flight CLIs     | **Implemented** in control plane / agent loop ([host-daemon.md](host-daemon.md#auto-update-graceful-restart)) |
| Signed update orchestration core         | **Implemented and locally tested** behind injected fetch/install/restart boundaries                           |
| Automatic production download / restart  | **Not wired**; updates use the manual drain procedure below                                                   |

---

## Prerequisites

- Node ≥ 22.18, Git 2.20+
- Target AI CLIs on `PATH` (`grok`, `codex`, …) for real profiles
- Control plane reachable (local [deploy-local.md](deploy-local.md) or AWS [deploy-aws.md](deploy-aws.md))
- Bound service-account API key when talking to a secured control plane ([auth.md](auth.md#vps-agent-authentication))

---

## Deploy (install)

On the agent host:

1. Install Node, Git, and AI CLIs.
2. Create a dedicated user and install the monorepo checkout at the unit's conventional path:

   ```bash
   sudo useradd --create-home --shell /usr/sbin/nologin harness
   sudo install -d -o harness -g harness /opt/auto-harness
   sudo -u harness git clone https://YOUR_GIT_REMOTE/auto-harness.git /opt/auto-harness/current
   sudo -u harness env CI=true corepack pnpm --dir /opt/auto-harness/current install --prod --frozen-lockfile
   ```

   The checked-in package uses Node's native TypeScript execution, so deploy the complete checkout and
   workspace dependencies. It is not a standalone compiled binary or npm tarball.

3. Create a **bound** service account on the control plane (`boundHostId` = this host’s `hostId`).
4. **Configure host inventory via API/UI** (not a local file): absolute repo/worktree paths, plus which catalog Provider Accounts are attached to this host. Commands resolve to named, fixed argv (D4 — no free-form shell) from the global Provider/Provider Account/Command catalogs, not a per-host profile map.
5. Set daemon identity/runtime values and only explicitly allowlisted child credentials on the host.
   Inventory remains in the control plane, not this file:

| Variable                      | Role                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `HARNESS_HOST_ID`             | Required agent id                                                                                             |
| `HARNESS_API_URL`             | Control plane base (`https://…` or `wss://…/ws`)                                                              |
| `HARNESS_API_KEY`             | Service account `hns_…`                                                                                       |
| `HARNESS_LOG_LEVEL`           | Optional (`info` default)                                                                                     |
| `HARNESS_CHILD_ENV_ALLOWLIST` | Optional comma-separated non-`HARNESS_*` names to forward to repository commands (for example `GITHUB_TOKEN`) |

6. Install the environment file and checked-in unit. Populate the copied environment file before starting;
   never commit it:

```bash
sudo install -d -m 0755 /etc/auto-harness
sudo install -m 0600 \
  /opt/auto-harness/current/services/host-daemon/systemd/host-daemon.env.example \
  /etc/auto-harness/host-daemon.env
sudoedit /etc/auto-harness/host-daemon.env
sudo install -m 0644 \
  /opt/auto-harness/current/services/host-daemon/systemd/auto-harness-host-daemon.service \
  /etc/systemd/system/auto-harness-host-daemon.service
sudo systemctl daemon-reload
sudo systemctl enable --now auto-harness-host-daemon.service
```

The unit runs as `harness`, starts the declared package entrypoint from
`/opt/auto-harness/current`, restarts after exits or crashes, and sends SIGTERM only to the daemon
first. `TimeoutStopSec=infinity` plus `KillMode=mixed` lets the daemon durably enter drain and wait
for in-flight CLIs instead of having systemd kill the whole cgroup. An operator can still use an
explicit `systemctl kill --kill-who=all --signal=SIGKILL auto-harness-host-daemon.service` for an
acknowledged emergency; that is not the normal update path.

The service is `Type=simple`: the daemon does not implement `sd_notify` or a systemd watchdog.
`systemctl status` proves process liveness, while host online/keepalive state in the control plane is
the readiness signal. Do not add `Type=notify`, `WatchdogSec`, or `ExecReload` without implementing
their daemon protocols first.

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

The verifier reads the root-only environment file without echoing its API key, converts either an
HTTP(S) base or WS(S) `/ws` endpoint to the REST base, and authenticates every request. Keep the
installed file in the example's unquoted `KEY=value` form; systemd environment files are not shell
scripts.

Host inventory template: [examples/local/host-inventory.config.json](../examples/local/host-inventory.config.json). Runbooks: [local-development.md](local-development.md), [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md).

---

## Update

### Agent binary / package

Current path — an operator must **drain, deploy, then restart** ([host-daemon.md](host-daemon.md#auto-update-graceful-restart)):

1. Signal drain:
   - Control plane: `POST /api/v1/hosts/drain` with `{ "hostId": "…" }`
   - And/or agent-local drain signal
2. Wait until no running sessions on that agent.
3. Fetch and check out the new immutable revision, then install its locked production dependencies:

   ```bash
   sudo -u harness git -C /opt/auto-harness/current fetch --all --tags
   sudo -u harness git -C /opt/auto-harness/current checkout NEW_IMMUTABLE_REVISION
   sudo -u harness env CI=true corepack pnpm --dir /opt/auto-harness/current install --prod --frozen-lockfile
   sudo install -m 0644 \
     /opt/auto-harness/current/services/host-daemon/systemd/auto-harness-host-daemon.service \
     /etc/systemd/system/auto-harness-host-daemon.service
   sudo systemctl daemon-reload
   ```

4. Restart only after drain, then verify registration:

   ```bash
   sudo systemctl restart auto-harness-host-daemon.service
   sudo systemctl status auto-harness-host-daemon.service
   ```

5. Confirm re-register and capacity restored (`draining` cleared).

Do **not** kill in-flight AI CLIs for routine upgrades.

`AgentUpdater` implements the ordered state machine for a signed Ed25519 manifest: compare version,
durably drain, wait for idle, fetch and SHA-256 verify the artifact, stage, request activation, and
request supervisor restart. Concurrent runs collapse into one update. Production fetch/install/
restart boundaries are intentionally not configured yet, so operators still use the manual steps
above until those host-mutating adapters are explicitly enabled and validated.

### Rollback

Use the same drain boundary, check out the previously verified immutable revision, restore its locked
dependencies, and restart:

```bash
sudo -u harness git -C /opt/auto-harness/current checkout PREVIOUS_IMMUTABLE_REVISION
sudo -u harness env CI=true corepack pnpm --dir /opt/auto-harness/current install --prod --frozen-lockfile
sudo install -m 0644 \
  /opt/auto-harness/current/services/host-daemon/systemd/auto-harness-host-daemon.service \
  /etc/systemd/system/auto-harness-host-daemon.service
sudo systemctl daemon-reload
sudo systemctl restart auto-harness-host-daemon.service
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
2. Stop and disable the service (SIGTERM follows the same graceful drain path):

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

The repository validates the unit contract with `pnpm check:systemd`, uses `systemd-analyze verify`
when it is available, and runs the packaged entrypoint against a real local HTTP/WebSocket control
plane while SIGTERM arrives during an active CLI. These are packaging and process-lifecycle proofs;
they do not claim that CI installed, enabled, stopped, or restarted a service on a production host.

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
