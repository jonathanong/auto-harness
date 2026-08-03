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
3. Create agent config:
   - **Absolute** paths for repos and worktrees
   - Named **`commandProfiles` only** (D4 — no free-form shell over the API)
4. Create a **bound** service account on the control plane (`boundAgentId` = this host’s `agentId`).
5. Set env / config:

| Variable              | Role                                                            |
| --------------------- | --------------------------------------------------------------- |
| `HARNESS_CONFIG_PATH` | Path to agent JSON (default `./auto-harness-agent.config.json`) |
| `HARNESS_AGENT_ID`    | Optional override of config `agentId`                           |
| `HARNESS_API_URL`     | Control plane base or `wss://…/ws`                              |
| `HARNESS_API_KEY`     | Service account `hns_…`                                         |
| `HARNESS_LOG_LEVEL`   | `info` default                                                  |

6. Start daemon:

```bash
# Local control plane
pnpm local:agent start --config /abs/path/agent.config.json --ws ws://127.0.0.1:7420/ws

# Production control plane
pnpm local:agent start --config /abs/path/agent.config.json --ws wss://YOUR_API/ws
# production: same entry under systemd (Restart=always), long TimeoutStopSec for drain
```

7. Confirm control plane shows agent online and profiles:

```bash
curl -sS "$HARNESS_API_URL/api/v1/agents"   # or local http://127.0.0.1:7420
curl -sS "$HARNESS_API_URL/api/v1/command-profiles"
```

Config shape examples: [local-development.md](local-development.md), [agent-e2e-testing.md](agent-e2e-testing.md).

---

## Update

### Agent binary / package

Preferred path — **drain, then restart** ([agent.md](agent.md#auto-update-graceful-restart)):

1. Signal drain:
   - Control plane: `POST /api/v1/agents/drain` with `{ "agentId": "…" }`
   - And/or agent-local drain signal
2. Wait until no running sessions on that agent.
3. Deploy new agent code/binary.
4. Restart process (systemd restart after drain — not `kill -9`).
5. Confirm re-register and capacity restored (`draining` cleared).

Do **not** kill in-flight AI CLIs for routine upgrades.

### Command profiles / repos

- Edit agent config (new profile argv, worktree paths).
- Restart agent after drain if inventory must change mid-flight.
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
| After agent install/update | Online in `/agents`, expected profiles, one smoke session                                    |
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
