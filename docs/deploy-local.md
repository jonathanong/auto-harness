# Deploy — local stack

**Supported today.** DynamoDB Local + local API (+ optional web) + agent for development and pre-deploy proof.

Ops index: [deploy.md](deploy.md). Day-to-day commands: [local-development.md](local-development.md). Full E2E checklist: [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md).

Other surfaces: [deploy-aws.md](deploy-aws.md) · [deploy-host-daemon.md](deploy-host-daemon.md).

---

## Prerequisites

- Node.js ≥ 22.18, pnpm, Docker, Git 2.20+
- Optional: non-interactive AI CLI (`grok`, `codex`, …) for real profile tests

```bash
pnpm install
pnpm check
```

---

## Deploy (start)

```bash
# Data plane
pnpm local:dynamodb
pnpm local:dynamodb:ready

# Optional: clear leftover sessions/worktrees (avoids stale queue assigns)
export HARNESS_DDB_ENDPOINT=http://127.0.0.1:7423
export AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1
node --input-type=module <<'EOF'
import { createControlPlane } from "./services/api/src/create-plane.ts";
const { storage } = await createControlPlane({
  tablePrefix: process.env.HARNESS_DDB_PREFIX ?? "AutoHarness",
  publicBaseUrl: "http://127.0.0.1:7421",
});
await storage.clearAll();
console.log(JSON.stringify({ ok: true }));
EOF

# Control plane (REST + WebSocket /ws)
pnpm local:api
# → http://127.0.0.1:7420

# Optional rate-limit tuning (safe defaults are used when unset)
# HARNESS_RATE_LIMIT_MUTATION=60 HARNESS_RATE_LIMIT_READ=300 pnpm local:api

# Control-plane UI
pnpm local:web
# → http://127.0.0.1:7421

# Host pane + daemon (env defaults: local-1 → :7420)
pnpm local:host-pane
# → http://127.0.0.1:7422
pnpm local:daemon start
# registers online; then add local repos at http://127.0.0.1:7422/repositories
```

Or run everything above — except DynamoDB Local, which stays in Docker — in one tmux session (one window each): `pnpm local:tmux`.

### Health

```bash
curl -sS http://127.0.0.1:7420/health
curl -sS http://127.0.0.1:7420/api/v1/hosts
curl -sS http://127.0.0.1:7420/api/v1/session-targets   # attached provider accounts + standalone commands
```

Session path after the host daemon is online: `POST /api/v1/sessions` (optionally with a global exact `concurrencyId`) then `POST /api/v1/scheduler/assign` (local create does not auto-assign). A duplicate active identity returns `200`/`created: false`; a new session returns `201`/`created: true`. Details: [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md).

---

## Update

| Piece                | How                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monorepo code        | `git pull` → `pnpm install` → re-run `pnpm check` if changing code                                                                                     |
| API / web            | Stop process, restart `pnpm local:api` / `pnpm local:web` (no build step)                                                                              |
| Agent binary/config  | Prefer **drain then restart** — same idea as production ([deploy-host-daemon.md](deploy-host-daemon.md)); restart `local:daemon start` with new config |
| DynamoDB Local image | `pnpm local:dynamodb:down` then `pnpm local:dynamodb` (data is container-local unless you bind a volume)                                               |
| Schema / tables      | `pnpm local:dynamodb:ready` re-ensures tables for the current prefix                                                                                   |

Local API drain: `POST /api/v1/hosts/drain` with `{ "hostId": "…" }`. Agent drain semantics: [host-daemon.md — Auto-update](host-daemon.md#auto-update-graceful-restart).

---

## Teardown

```bash
# Stop agent, web, API (if you saved PIDs)
kill "$(cat /path/to/agent.pid)" 2>/dev/null || true
kill "$(cat /path/to/web.pid)" 2>/dev/null || true
kill "$(cat /path/to/api.pid)" 2>/dev/null || true

# Or free ports (DynamoDB Local :7423 is a Docker container — use `pnpm local:dynamodb:down`)
for p in 7420 7421 7422; do
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

## Gates

| When                                | Gate                                                              |
| ----------------------------------- | ----------------------------------------------------------------- |
| Before claiming local stack is good | [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md) sign-off |
| After code change                   | `pnpm check` + relevant `pnpm local:*` scripts                    |

---

## Related

| Doc                                            | Role                     |
| ---------------------------------------------- | ------------------------ |
| [deploy.md](deploy.md)                         | Ops index (all surfaces) |
| [deploy-aws.md](deploy-aws.md)                 | AWS control plane        |
| [deploy-host-daemon.md](deploy-host-daemon.md) | VPS agent                |
| [local-development.md](local-development.md)   | Day-to-day commands      |
