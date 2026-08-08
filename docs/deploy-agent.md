# Deploy — VPS agent

Agent host: trusted machine that holds git + AI credentials and runs non-interactive CLIs. Security: [security.md](security.md). Internals: [agent.md](agent.md). CLI: [cli.md](cli.md).

Ops index: [deploy.md](deploy.md). Local stack: [deploy-local.md](deploy-local.md). AWS control plane: [deploy-aws.md](deploy-aws.md).

---

## Maturity

| Item                                    | Status                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Local daemon (`pnpm local:agent start`) | **Supported** against local API/WS                                                                |
| Production systemd unit                 | **Intended shape** — document and validate per host                                               |
| Drain without killing in-flight CLIs    | **Implemented** in control plane / agent loop ([agent.md](agent.md#auto-update-graceful-restart)) |

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
2. Clone or install the agent package / monorepo checkout used for `auto-harness-agent`.
3. Create a **bound** service account on the control plane (`boundHostId` = this host’s `hostId`).
4. **Configure host inventory via API/UI** (not a local file): absolute repo/worktree paths, plus which catalog Provider Accounts are attached to this host. Commands resolve to named, fixed argv (D4 — no free-form shell) from the global Provider/Provider Account/Command catalogs, not a per-host profile map.
5. Set **only** identity env vars on the host:

| Variable            | Role                                             |
| ------------------- | ------------------------------------------------ |
| `HARNESS_AGENT_ID`  | Required agent id                                |
| `HARNESS_API_URL`   | Control plane base (`https://…` or `wss://…/ws`) |
| `HARNESS_API_KEY`   | Service account `hns_…`                          |
| `HARNESS_LOG_LEVEL` | Optional (`info` default)                        |

6. Start daemon:

```bash
export HARNESS_AGENT_ID=prod-1
export HARNESS_API_URL=https://YOUR_API   # or wss://YOUR_API/ws
export HARNESS_API_KEY=hns_…

# Local control plane
pnpm local:agent start

# Production: same entry under systemd (Restart=always), long TimeoutStopSec for drain
pnpm local:agent start
```

7. Confirm control plane shows the agent online with its attached provider accounts:

```bash
curl -sS "$HARNESS_API_URL/api/v1/agents"
curl -sS "$HARNESS_API_URL/api/v1/agents/$HARNESS_AGENT_ID/config"
curl -sS "$HARNESS_API_URL/api/v1/session-targets"   # attached provider accounts + standalone commands
```

Host inventory template: [examples/local/agent-host.config.json](../examples/local/agent-host.config.json). Runbooks: [local-development.md](local-development.md), [agent-e2e-testing.md](agent-e2e-testing.md).

---

## Update

### Agent binary / package

Preferred path — **drain, then restart** ([agent.md](agent.md#auto-update-graceful-restart)):

1. Signal drain:
   - Control plane: `POST /api/v1/agents/drain` with `{ "hostId": "…" }`
   - And/or agent-local drain signal
2. Wait until no running sessions on that agent.
3. Deploy new agent code/binary.
4. Restart process (systemd restart after drain — not `kill -9`).
5. Confirm re-register and capacity restored (`draining` cleared).

Do **not** kill in-flight AI CLIs for routine upgrades.

### Command profiles / repos

- Update host inventory via `PUT /api/v1/agents/:hostId/config` or the Agents UI.
- Restart agent after drain so it re-bootstraps the new inventory.
- Keep profile names stable when possible so schedules/UI selections keep working.

### Relation to control plane updates

When the **API** changes: roll control plane first ([deploy-aws.md](deploy-aws.md) / [deploy-local.md](deploy-local.md)), then roll agents with this drain path.

---

## Teardown

1. Drain agent; wait for idle.
2. Stop service (`systemctl stop …` or graceful stop of the start process).
3. Optionally remove worktrees and config from disk.
4. Delete or rotate the service-account API key on the control plane.
5. Confirm `GET /api/v1/agents` no longer lists the agent as online.

---

## Gates

| When                       | Gate                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| After agent install/update | Online in `/hosts`, expected profiles, one smoke session                                     |
| After hard kill / crash    | Re-register; reconcile running sessions ([agent.md](agent.md#disconnect-and-crash-recovery)) |

---

## Related

| Doc                                | Role                       |
| ---------------------------------- | -------------------------- |
| [deploy.md](deploy.md)             | Ops index                  |
| [deploy-local.md](deploy-local.md) | Local control plane        |
| [deploy-aws.md](deploy-aws.md)     | AWS control plane          |
| [agent.md](agent.md)               | Drain / recovery internals |
| [cli.md](cli.md)                   | Agent CLI                  |
| [auth.md](auth.md)                 | Bound API keys             |
| [security.md](security.md)         | Host hardening             |
