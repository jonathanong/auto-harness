# Deploy, update, and teardown

Ops guide for **running** Auto Harness: local stack (supported today) and AWS/VPS production shape (design target). Architecture: [aws.md](aws.md). Local day-to-day: [local-development.md](local-development.md). Pre-deploy E2E: [agent-e2e-testing.md](agent-e2e-testing.md). Auth secrets: [auth.md](auth.md).

---

## Maturity

| Surface                                                                | Deploy / update / teardown                                                                                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local** (DynamoDB Local + API + optional web + agent)                | **Supported** — this doc §1                                                                                                                                                                  |
| **AWS control plane** (API Gateway, Lambda, DynamoDB, S3, EventBridge) | **Design only** — CDK package is not a full deployable stack yet (`services/cdk` defines table metadata / identity; no complete `cdk deploy` app). Follow §2 when implementing/operating it. |
| **VPS agent** (daemon + CLI profiles + git worktrees)                  | **Partial** — run/start documented; production install via systemd is the intended shape (§3).                                                                                               |

Do **not** treat `pnpm --filter @auto-harness/cdk deploy` as production-ready until a real CDK app lands and this doc’s AWS sections are validated against a real account.

---

## 1. Local stack (supported)

Use this for development and pre-deploy proof. Full E2E checklist: [agent-e2e-testing.md](agent-e2e-testing.md).

### 1.1 Prerequisites

- Node.js ≥ 22.18, pnpm, Docker, Git 2.20+
- Optional: non-interactive AI CLI (`grok`, `codex`, …) for real profile tests

```bash
pnpm install
pnpm check
```

### 1.2 Deploy (start)

```bash
# Data plane
pnpm local:dynamodb
pnpm local:dynamodb:ready

# Optional: clear leftover sessions/worktrees (avoids stale queue assigns)
export HARNESS_DDB_ENDPOINT=http://127.0.0.1:8000
export AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1
node --input-type=module <<'EOF'
import { createControlPlane } from "./services/api/src/create-plane.ts";
const { storage } = await createControlPlane({
  tablePrefix: process.env.HARNESS_DDB_PREFIX ?? "AutoHarness",
  publicBaseUrl: "http://127.0.0.1:3000",
});
await storage.clearAll();
console.log(JSON.stringify({ ok: true }));
EOF

# Control plane (REST + WebSocket /ws)
pnpm local:api
# → http://127.0.0.1:7420

# Optional thin web UI
HARNESS_API_HTTP=http://127.0.0.1:7420 pnpm local:web
# → http://127.0.0.1:3000

# Agent (daemon) — needs agent.config.json with absolute repo/worktree paths
pnpm local:agent start --config /abs/path/to/agent.config.json --ws ws://127.0.0.1:7420/ws
```

**Health:**

```bash
curl -sS http://127.0.0.1:7420/health
curl -sS http://127.0.0.1:7420/api/v1/agents
curl -sS http://127.0.0.1:7420/api/v1/command-profiles
```

Session path after agent is online: `POST /api/v1/sessions` then `POST /api/v1/scheduler/assign` (local create does not auto-assign). Details: [agent-e2e-testing.md](agent-e2e-testing.md).

### 1.3 Update (local)

| Piece                | How                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo code        | `git pull` → `pnpm install` → re-run `pnpm check` if changing code                                                                          |
| API / web            | Stop process, restart `pnpm local:api` / `pnpm local:web` (no build step)                                                                   |
| Agent binary/config  | Prefer **drain then restart** (same idea as production): stop accepting work, finish in-flight, restart `local:agent start` with new config |
| DynamoDB Local image | `pnpm local:dynamodb:down` then `pnpm local:dynamodb` (data is container-local unless you bind a volume)                                    |
| Schema / tables      | `pnpm local:dynamodb:ready` re-ensures tables for the current prefix                                                                        |

Agent drain behavior (no kill of in-flight CLIs): [agent.md — Auto-update](agent.md#auto-update-graceful-restart). Local API drain: `POST /api/v1/agents/drain` with `{ "agentId": "…" }`.

### 1.4 Teardown (local)

```bash
# Stop agent, web, API (if you saved PIDs)
kill "$(cat /path/to/agent.pid)" 2>/dev/null || true
kill "$(cat /path/to/web.pid)" 2>/dev/null || true
kill "$(cat /path/to/api.pid)" 2>/dev/null || true

# Or free ports
for p in 7420 3000; do
  for pid in $(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null || true); do
    kill "$pid" 2>/dev/null || true
  done
done

# Stop DynamoDB Local container
pnpm local:dynamodb:down

# Optional: remove throwaway demo workspaces
rm -rf .local-agent-e2e .local-grok-demo   # if you created them
```

**Data note:** clearing tables (`storage.clearAll()`) deletes local control-plane state only. It does not remove git worktrees on disk.

---

## 2. AWS control plane (target ops)

Design source of truth: [aws.md](aws.md). Implementation status: **CDK not fully implemented** — treat the following as the contract to implement and operate against.

### 2.1 Prerequisites (when deploying)

- AWS account + credentials with rights for CloudFormation/CDK, Lambda, API Gateway, DynamoDB, S3, EventBridge, IAM, (optional) KMS
- Node 22.x for Lambda runtime alignment when packaging
- `cdk` CLI / `aws` CLI bootstrap in the target account/region
- Pre-deploy local proof: [agent-e2e-testing.md](agent-e2e-testing.md) checklist green

### 2.2 Secrets and config (never commit)

| Variable                 | Purpose                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `HARNESS_ADMINS`         | Base64 JSON `[{ "username", "password" }]` bootstrap admins |
| `HARNESS_SESSION_SECRET` | JWT signing for UI session cookies                          |
| `WEB_ORIGIN`             | CORS allow-list for the web UI origin                       |
| Table names / prefix     | From stack (see [aws.md](aws.md) env table)                 |
| `ARCHIVE_BUCKET`         | S3 archive bucket                                           |
| `WS_API_ENDPOINT`        | API Gateway Management API for `postToConnection`           |
| `KMS_KEY_ID`             | Optional — Slack / integration secrets                      |

Rotation: change secret in the secret store / stack parameter → redeploy or update function configuration → verify login/WS. Admin bootstrap rotation requires redeploy of the Lambda env that holds `HARNESS_ADMINS` ([auth.md](auth.md)).

### 2.3 Deploy (target)

Intended shape (update paths when the CDK app lands under `services/cdk`):

```bash
pnpm install
# bootstrap once per account/region if needed:
#   npx cdk bootstrap aws://ACCOUNT/REGION

# synthesize / deploy (illustrative — enable when package scripts exist)
pnpm --filter @auto-harness/cdk deploy
# or: npx cdk deploy --app '…' --all
```

Expected stack outputs (from design):

| Output              | Consumer                     |
| ------------------- | ---------------------------- |
| `RestApiUrl`        | Web UI, CI `HARNESS_API_URL` |
| `WebSocketUrl`      | Agent connect (`wss://…/ws`) |
| `ArchiveBucketName` | Ops                          |
| `Region`            | Clients                      |

Post-deploy smoke (minimum):

1. `GET {RestApiUrl}/health` or equivalent health route
2. Create operator service account / bind agent key ([auth.md](auth.md#vps-agent-authentication))
3. Register at least one repository
4. Connect one agent with `HARNESS_API_URL` / `HARNESS_API_KEY`
5. `POST /sessions` + observe assign over WebSocket → terminal status

### 2.4 Update (target)

| Change                      | Procedure                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Lambda/handler code         | Build/bundle → `cdk deploy` (or pipeline) → verify health + one session                                           |
| Infra (tables, routes, IAM) | `cdk diff` → `cdk deploy` → watch CloudWatch for errors                                                           |
| Env / secrets               | Update parameter store / CDK context → redeploy or `update-function-configuration` → smoke login + agent register |
| Breaking API changes        | Drain agents if needed → deploy control plane → roll agents → re-run E2E                                          |
| Data migrations             | Prefer additive DynamoDB attributes; document any one-time backfill in the PR                                     |

Prefer **control plane first**, then agents, so old agents fail closed on unknown messages rather than new agents talking to old APIs.

### 2.5 Teardown (target)

```bash
# After confirming no production traffic / agents drained
pnpm --filter @auto-harness/cdk destroy
# or: npx cdk destroy --all
```

Also:

1. Drain and stop all VPS agents (§3.4).
2. Confirm DynamoDB tables and S3 archive bucket deletion policy (retain vs destroy — set retention in CDK before first prod deploy).
3. Revoke service-account API keys and rotate any shared secrets.
4. Remove DNS / custom domain bindings if used.

Until destroy is validated in a non-prod account, treat teardown as **manual CloudFormation stack delete + agent stop**.

---

## 3. VPS agent (production shape)

### 3.1 Deploy (install)

On the agent host (trusted machine; holds git + AI credentials — [security.md](security.md)):

1. Install Node ≥ 22.18, Git, and target AI CLIs (`grok`, `codex`, …).
2. Clone or install the agent package / monorepo checkout used for `auto-harness-agent`.
3. Create agent config (absolute paths for repos/worktrees; named `commandProfiles` only — D4).
4. Create a **bound** service account API key on the control plane (`boundAgentId` = this host’s `agentId`).
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
pnpm local:agent start --config /abs/path/agent.config.json --ws wss://YOUR_API/ws
# production: same entry under systemd (Restart=always), with long TimeoutStopSec for drain
```

7. Confirm control plane shows agent online and profiles: `GET /api/v1/agents`, `GET /api/v1/command-profiles`.

### 3.2 Update (agent)

Preferred path — **drain, then restart** ([agent.md](agent.md#auto-update-graceful-restart)):

1. Signal drain (control plane `POST /api/v1/agents/drain` and/or agent-local drain).
2. Wait until no running sessions on that agent.
3. Deploy new agent code/binary.
4. Restart process (systemd restart after drain, not `kill -9`).
5. Confirm re-register and `draining: false`.

Do **not** kill in-flight AI CLIs for routine upgrades.

### 3.3 Update (command profiles / repos)

- Edit agent config (new profile argv, worktree paths).
- Restart agent after drain if inventory must change mid-flight.
- Keep profile names stable when possible so existing schedules/UI selections keep working.

### 3.4 Teardown (agent)

1. Drain agent; wait for idle.
2. Stop service (`systemctl stop …` or kill the start process gracefully).
3. Optionally remove worktrees and config from disk.
4. Delete or rotate the service-account API key on the control plane.
5. Confirm `GET /api/v1/agents` no longer lists the agent as online.

---

## 4. Pre-deploy / post-deploy gates

| When                        | Gate                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| Before any claim of “ready” | [agent-e2e-testing.md](agent-e2e-testing.md) sign-off checklist             |
| After local code change     | `pnpm check` + relevant `pnpm local:*` scripts                              |
| After AWS deploy            | Health, agent register, one full session lifecycle, CloudWatch errors quiet |
| After agent update          | Drain complete, re-register, one smoke session                              |

---

## 5. Related docs

| Doc                                          | Role                             |
| -------------------------------------------- | -------------------------------- |
| [local-development.md](local-development.md) | Local commands                   |
| [agent-e2e-testing.md](agent-e2e-testing.md) | Pre-deploy E2E                   |
| [setup.md](setup.md)                         | Install / secrets overview       |
| [aws.md](aws.md)                             | Control plane design             |
| [agent.md](agent.md)                         | Agent drain / recovery           |
| [auth.md](auth.md)                           | Keys, binding, login             |
| [security.md](security.md)                   | Trust boundaries, host hardening |
