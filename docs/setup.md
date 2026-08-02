# Setup

Install and run Auto-Harness: AWS control plane, VPS agent, and local dev. Design details stay in [aws.md](aws.md) / [agent.md](agent.md).

## Prerequisites

| Piece       | Need                                    |
| ----------- | --------------------------------------- |
| AWS account | For cloud deploy (CDK)                  |
| Node.js 20+ | API, web, agent builds                  |
| pnpm        | Monorepo                                |
| Git 2.20+   | Worktrees on the agent host             |
| AI CLIs     | Codex / Claude / etc. on the agent host |
| Docker      | Optional; DynamoDB Local for dev        |

---

## AWS control plane

1. Clone monorepo; `pnpm install`
2. Configure secrets (do not commit):
   - `HARNESS_ADMINS` — base64 JSON `[{ "username", "password" }]`
   - `HARNESS_SESSION_SECRET` — long random string for UI JWTs
   - `WEB_ORIGIN` — browser origin for CORS
3. Deploy stack:

```bash
pnpm --filter @auto-harness/cdk deploy
```

4. Note stack outputs: `RestApiUrl`, `WebSocketUrl`
5. Log in to Web UI (or REST) as admin → create **user** accounts and **service accounts**
6. Create an **agent** service account with `boundAgentId` = your VPS agent id; save `hns_…` key once
7. Add **repositories** in the UI (ids must match agent config)

Full table/env/IAM: [aws.md](aws.md). Auth model: [security.md](security.md).

---

## VPS agent

1. On the host, clone monorepo (or install the agent package) and build:

```bash
pnpm install
pnpm --filter @auto-harness/agent build
```

2. Clone application repos to paths you will reference in config (e.g. `/home/harness/repos/my-app`)
3. Write config (example):

```json
{
  "apiUrl": "wss://YOUR_WS_URL/ws",
  "apiKey": "hns_…",
  "agentId": "vps-prod-1",
  "repositories": [
    {
      "id": "repo-abc",
      "path": "/home/harness/repos/my-app",
      "worktrees": [
        {
          "id": "wt-1",
          "path": "/home/harness/repos/my-app/.worktrees/wt-1",
          "labels": ["codex", "claude"],
          "setupScript": "git fetch && git reset --hard origin/main && pnpm install"
        }
      ]
    }
  ]
}
```

4. Authenticate AI **CLIs under subscription plans** on the host (or API keys only if you deliberately choose that cost model). Git SSH stays on the host. Never put secrets in REST prompts. Subscriptions do not expose Agent SDKs for this path—use **non-interactive CLI** flags. See [why.md](why.md) and [costs.md](costs.md).
5. Validate and start:

```bash
export HARNESS_CONFIG_PATH=/home/harness/auto-harness-agent.config.json
auto-harness-agent validate
auto-harness-agent start
```

6. Production: systemd unit running as user `harness` (example):

```ini
[Unit]
Description=Auto-Harness Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=harness
Group=harness
WorkingDirectory=/home/harness/harness
ExecStart=/usr/bin/node services/agent/dist/index.js start
Restart=always
RestartSec=10
Environment=HARNESS_CONFIG_PATH=/home/harness/auto-harness-agent.config.json
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/home/harness

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now auto-harness-agent
```

CLI reference: [cli.md](cli.md). Worktree/labels behavior: [agent.md](agent.md).

### Auto-update

Agent upgrades use a **drain-then-restart** path: stop accepting new jobs, let in-process CLI sessions finish, then restart the service. Auto-update does **not** kill running CLIs. Details: [agent.md — Auto-update](agent.md#auto-update-graceful-restart).

### Env vars (agent)

| Variable              | Required | Default                            |
| --------------------- | -------- | ---------------------------------- |
| `HARNESS_API_URL`     | yes\*    | from config `apiUrl`               |
| `HARNESS_API_KEY`     | yes\*    | from config `apiKey`               |
| `HARNESS_AGENT_ID`    | no       | config / hostname                  |
| `HARNESS_CONFIG_PATH` | no       | `./auto-harness-agent.config.json` |
| `HARNESS_LOG_LEVEL`   | no       | `info`                             |

\*Required overall via config or env.

---

## Local development

Runs the same handlers without AWS:

```text
Web UI :3000 → API :7420 ←WSS→ Agent
                  ↓
           DynamoDB Local :8000
```

```bash
# 1. DynamoDB Local
docker run -p 8000:8000 amazon/dynamodb-local

# 2. API (creates tables, seeds admin/admin)
pnpm --filter @auto-harness/api dev

# 3. Web
pnpm --filter @auto-harness/web dev

# 4. Agent
HARNESS_API_URL=ws://localhost:7420/ws \
HARNESS_API_KEY=<local-key> \
HARNESS_AGENT_ID=local-1 \
auto-harness-agent start
```

| Feature                  | Local          | Cloud |
| ------------------------ | -------------- | ----- |
| REST + WebSocket + agent | ✓              | ✓     |
| DynamoDB                 | Local          | AWS   |
| S3 archival              | ✗              | ✓     |
| Slack                    | ✗              | ✓     |
| EventBridge cron         | Manual trigger | ✓     |

Example env templates:

```bash
# services/api/.env
AWS_ENDPOINT_URL=http://localhost:8000
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local
HARNESS_ADMINS=W3sidXNlcm5hbWUiOiJhZG1pbiIsInBhc3N3b3JkIjoiYWRtaW4ifV0=
HARNESS_SESSION_SECRET=local-dev-secret

# services/web/.env
NEXT_PUBLIC_API_URL=http://localhost:7420
NEXT_PUBLIC_WS_URL=ws://localhost:7420/ws
```

---

## First session checklist

1. Control plane up (cloud or local)
2. Repository created in API/UI with known `id`
3. Agent online (`auto-harness-agent status` / UI Agents)
4. Worktree labels match session `requiredLabels`
5. `POST /sessions` or Web UI “New Session”
6. Watch logs in UI ([websocket.md](websocket.md))

---

## Security reminders

- No secrets in prompts or REST session bodies
- Agent holds git + AI keys
- Rotate service accounts by create-new → swap → delete-old

See [security.md](security.md).
