# WebSocket Protocol

Real-time channel between the control plane, VPS agents, and the Web UI. REST CRUD is documented in [api.md](api.md). Agent internals: [host-daemon.md](host-daemon.md). Server routing/IAM: [aws.md](aws.md).

`session:usage` is a host-to-control-plane message carrying a CLI-authoritative provider-neutral
usage record (`sessionId`, `worktreeId`, `attemptId`, and `usage`). The control plane ignores stale
attempts and stale host connections, deduplicates sequence numbers, and never derives usage from
prompts or log chunks.

## Endpoint

```
wss://<api-domain>/ws with `Authorization: Bearer <credential>`
```

| Connection | Credential                                                           | First message     |
| ---------- | -------------------------------------------------------------------- | ----------------- |
| VPS agent  | Service account API key (`hns_…`) bound to `hostId`                  | `host:register`   |
| Web UI     | Short-lived ticket or session-derived token (see [auth.md](auth.md)) | `client:register` |

All application messages are JSON with a `type` field. API Gateway routes: `$connect`, `$disconnect`, `$default`.

Unauthenticated connect → reject. Keepalive: **agent-initiated** (`host:keepalive`); Lambda has no server-side ping timer.

---

## Agent ↔ server

### Server → agent

| Type             | Payload                                                                                                                                                                                | Purpose                                                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session:assign` | `sessionId`, `attemptId`, `repositoryId`, `prompt`, `resolvedArgv`, `timeout`, `worktreeId?`, `ref?`, `setupScript?`, `resume?`, `resumedFromSessionId?`, `cliResumeRef?`, `metadata?` | Run or **resume** a session (`attemptId` is an immutable assignment fence that must be echoed in ACK/status; `worktreeId` null = main checkout); `resolvedArgv` is already resolved control-plane-side from a Provider Account/Command (D4) — the agent never resolves a target, just spawns it |
| `session:cancel` | `sessionId`                                                                                                                                                                            | Stop queued/running work                                                                                                                                                                                                                                                                        |
| `ping`           | `{}`                                                                                                                                                                                   | Keepalive                                                                                                                                                                                                                                                                                       |

Scheduled main-checkout assignments use `sessionType: "scheduled"` and
`worktreeId: null`; hosts must not route them through worktree handling.

```json
{
  "type": "session:assign",
  "sessionId": "sess-x1y2z3",
  "attemptId": "attempt-4e6b9a",
  "repositoryId": "repo-abc",
  "prompt": "Fix the failing test in src/utils.test.ts",
  "resolvedArgv": ["codex", "exec", "Fix the failing test in src/utils.test.ts"],
  "ref": "main",
  "timeout": 1800,
  "worktreeId": "wt-1",
  "setupScript": "git fetch && git reset --hard origin/main && pnpm install"
}
```

**Resume assign** (native route preferred; fresh fallback route if unavailable):

```json
{
  "type": "session:assign",
  "sessionId": "sess-r9s8t7",
  "attemptId": "attempt-71d2cc",
  "repositoryId": "repo-abc",
  "prompt": "Continue: also fix the edge case",
  "resolvedArgv": ["codex", "exec", "Continue: also fix the edge case"],
  "ref": "main",
  "timeout": 1800,
  "worktreeId": "wt-1",
  "resume": true,
  "resumedFromSessionId": "sess-x1y2z3",
  "cliResumeRef": "optional-tool-native-id"
}
```

When `resume: true`, the agent must **not** treat this as a fresh clean setup (avoid destructive reset). See [host-daemon.md — Session resume](host-daemon.md#session-resume).

### Agent → server

| Type              | Payload                                                                                                                                               | Purpose                                                                                                                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host:register`   | `hostId`, `worktrees[]`, `commandProfiles[]`, optional `repositories[]`, optional `capabilities[]`, optional `runningSessions[]`, optional `draining` | Inventory, executable command profiles, repository metadata, rollout capabilities, reclaim after reconnect, and a reconnecting drain intent                                                                                                                                                                   |
| `session:ack`     | `sessionId`, `worktreeId`, `attemptId`                                                                                                                | Accepted assign; echoes the immutable assignment fence                                                                                                                                                                                                                                                        |
| `session:status`  | `sessionId`, `worktreeId`, `attemptId`, `status`, `exitCode?`, `errorCode?`, `errorMessage?`                                                          | Lifecycle (`running`, `completed`, `failed`, `cancelled`, `timed_out`); echoes the assignment fence. Terminal status persists a captured native resume ref when available. On AI quota hits: `failed` + `errorCode: "usage_limit"` (see [host-daemon.md](host-daemon.md#usage-limits-ai-vendor--cli-quotas)). |
| `session:log`     | `sessionId`, `stream`, `content`, `timestamp`                                                                                                         | stdout / stderr / system chunk                                                                                                                                                                                                                                                                                |
| `worktree:status` | `worktreeId`, `status`, `currentSessionId?`                                                                                                           | idle / busy / error                                                                                                                                                                                                                                                                                           |
| `host:status`     | `hostId`, `draining: true`                                                                                                                            | Authenticated, connection-fenced request to durably drain this host; server replies `host:draining` only after commit                                                                                                                                                                                         |
| `pong`            | `{}`                                                                                                                                                  | Keepalive reply                                                                                                                                                                                                                                                                                               |

### Server → agent

| Type            | Payload  | Purpose                                                                                                                                        |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `host:draining` | `hostId` | Durable acknowledgement that the matching `host:status { draining: true }` request committed; the daemon may now finish its graceful shutdown. |

**Draining (auto-update):** agent sends `host:status { draining: true }` and waits for `host:draining` before it stops accepting new `session:assign`. The request is authenticated by the bound WebSocket identity and fenced to that connection epoch; a stale socket cannot drain a replacement. A reconnect while the request is pending registers with `draining: true`, preserving exclusion until shutdown completes. The agent then finishes in-flight sessions **without killing CLIs**, disconnects, and restarts. A fresh process registers without `draining` and restores capacity. See [host-daemon.md — Auto-update](host-daemon.md#auto-update-graceful-restart).

```json
{
  "type": "session:log",
  "sessionId": "sess-x1y2z3",
  "stream": "stdout",
  "content": "Analyzing codebase...\n",
  "timestamp": "2026-08-01T12:00:06.123Z"
}
```

`host:register` worktree item shape:

```json
{
  "id": "wt-1",
  "name": "codex-1",
  "repositoryId": "repo-abc",
  "path": "/home/harness/repos/my-app/.worktrees/wt-1",
  "labels": ["codex", "claude"]
}
```

`capabilities` is a bounded list of recognized daemon features. A daemon that
can safely execute scheduled sessions in the repository main checkout sends
`["scheduled-main-checkout"]`. Missing capabilities mean an older daemon and
normalize to `[]`; the scheduler must not send that daemon a null-worktree
assignment.

---

## Client (Web UI) ↔ server

### Client → server

| Type                  | Payload                                       |
| --------------------- | --------------------------------------------- |
| `client:register`     | `{ userId }` (or principal from connect auth) |
| `session:subscribe`   | `{ sessionId }`                               |
| `session:unsubscribe` | `{ sessionId }`                               |

### Server → client

| Type             | Payload                             |
| ---------------- | ----------------------------------- |
| `session:log`    | Same as agent log (forwarded)       |
| `session:status` | `{ sessionId, status, exitCode? }`  |
| `host:status`    | `{ hostId, status }` online/offline |

---

## Live session viewing

1. Connect + `client:register`
2. `session:subscribe` for a session id
3. Server **replays last ~100** buffered lines, then tails new `session:log`
4. `session:status` on terminal transitions
5. `session:unsubscribe` on leave (or auto on disconnect)

Notes:

- Many clients may subscribe to one session
- Full history: REST [`GET /sessions/:id/logs`](api.md); live tail: this protocol
- Streams may interleave; order is preserved per stream
- Agent rate-limits/batches logs; server persists to DynamoDB and fans out

---

## Connection lifecycle (agent)

```mermaid
sequenceDiagram
    participant Agent
    participant GW as API Gateway
    participant Lambda
    participant DDB as DynamoDB

    Agent->>GW: Connect with Authorization: Bearer hns_…
    GW->>Lambda: $connect
    Lambda->>DDB: Validate key - store Connection
    GW-->>Agent: open

    Agent->>GW: host:register
    Lambda->>DDB: Upsert worktrees
    Lambda-->>Agent: session:assign (if queued match)

    loop ~30s
        Lambda-->>Agent: ping
        Agent-->>Lambda: pong
    end

    Agent->>GW: disconnect
    Lambda->>DDB: Remove Connection - mark worktrees offline
```

Disconnect and reconnect reconciliation: [aws.md](aws.md#disconnect-handling), [host-daemon.md](host-daemon.md#disconnect-and-crash-recovery).

---

## Related

| Doc                                          | Role                                    |
| -------------------------------------------- | --------------------------------------- |
| [api.md](api.md)                             | REST                                    |
| [host-daemon.md](host-daemon.md)             | How the agent handles assign/log/status |
| [aws.md](aws.md)                             | Scheduler, fan-out, connections table   |
| [web.md](web.md)                             | UI live terminal                        |
| [setup.md](setup.md)                         | Deploy / URLs and tokens                |
| [local-development.md](local-development.md) | Local API + `/ws` e2e                   |
