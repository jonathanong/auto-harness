# Architecture

## System Overview

Auto-Harness operates on two planes:

- **Control Plane** (AWS) — API Gateway, Lambda, DynamoDB, S3. Handles API requests, session scheduling, WebSocket management, and log storage.
- **Execution Plane** (VPS) — Node.js agent daemon. Manages git worktrees, spawns AI CLI tools as child processes, streams output back to the control plane.

```mermaid
graph TB
    subgraph "Control Plane (AWS)"
        APIGW["API Gateway<br/>REST + WebSocket"]
        Lambda["Lambda Functions<br/>Handlers + Scheduler"]
        DDB["DynamoDB<br/>Sessions, Users, Connections"]
        S3["S3<br/>Archived Logs"]
    end

    subgraph "Clients"
        WebUI["Next.js Web UI"]
        CI["CI/CD Systems"]
        CLI["CLI / Scripts"]
    end

    subgraph "Execution Plane (VPS)"
        Agent["Auto-Harness Agent<br/>Node.js Daemon"]
        subgraph "Worktrees"
            WT1["wt-1 (codex, claude)"]
            WT2["wt-2 (codex)"]
            WT3["wt-3 (claude)"]
        end
    end

    WebUI -->|REST + WebSocket| APIGW
    CI -->|REST| APIGW
    CLI -->|REST| APIGW
    APIGW --> Lambda
    Lambda --> DDB
    Lambda --> S3
    Lambda <-->|WebSocket| Agent
    Agent --> WT1
    Agent --> WT2
    Agent --> WT3
```

## Component Design

### API Gateway

Two API types on a single gateway:

| API | Protocol | Purpose |
|-----|----------|---------|
| REST | HTTPS | CRUD operations — sessions, repos, auth |
| WebSocket | WSS | Real-time — agent communication, live log streaming to UI |

The WebSocket API handles two connection types:
- **Agent connections** — VPS agents that execute sessions
- **Client connections** — Web UI browsers that subscribe to live updates

Both authenticate via token but are distinguished by the first message sent (`agent:register` vs `client:register`).

### Lambda Functions

Organized as individual handlers, bundled per route:

| Handler Group | Routes | Responsibility |
|---------------|--------|----------------|
| Auth | `POST/GET/DELETE /auth/service-accounts` | Service account CRUD |
| Sessions | `POST/GET /sessions`, `POST /sessions/:id/cancel` | Session lifecycle |
| Repositories | `CRUD /repositories` | Repository management |
| Worktrees | `GET /worktrees` | Worktree read access |
| Agents | `GET /agents` | Agent status |
| Schedules | `CRUD /schedules`, `POST /schedules/:id/trigger` | Scheduled task management |
| Cron Evaluator | CloudWatch Events (1-min interval) | Evaluate due schedules, create sessions |
| WS Connect | `$connect` | Validate token, store connection |
| WS Disconnect | `$disconnect` | Clean up connection, mark worktrees offline |
| WS Message | `$default` | Route by message `type` field |
| Scheduler | (Internal) | Match queued sessions to available worktrees |

**Scheduler logic:**
1. On session creation: query available worktrees matching `requiredLabels`
2. If a matching idle worktree exists: push `session:assign` via WebSocket
3. If none available: session remains `queued` in DynamoDB
4. On worktree becoming idle: query highest-priority queued session matching its labels
5. Priority ties broken by `createdAt` (FIFO)

**Cron evaluator logic:**
1. Triggered by CloudWatch Events every 60 seconds
2. Queries Schedules table for records where `nextRunAt <= now` and `enabled: true`
3. Creates a session with `type: 'scheduled'`, `source: 'schedule'` for each due schedule
4. Scheduled sessions run on the main repository checkout (not worktrees)
5. Updates `lastRunAt` and computes the next `nextRunAt` from the cron expression

### DynamoDB Tables

| Table | PK | SK | GSIs | Description |
|-------|----|----|------|-------------|
| Users | `id` | — | `apiKeyHash` (auth lookups), `username` (login lookups) | User and service accounts |
| Repositories | `id` | — | — | Repository configuration |
| Sessions | `id` | — | `status-createdAt` (queue queries), `repositoryId-createdAt` | Session records |
| Schedules | `id` | — | `repositoryId-nextRunAt` (cron queries) | Scheduled maintenance tasks |
| SessionLogs | `sessionId` | `timestamp` | — | Append-only log entries (TTL-enabled) |
| Connections | `connectionId` | — | `agentId` (find agent's connection) | Active WebSocket connections |
| AuditLogs | `id` | `timestamp` | `userId-timestamp` | Mutating operation audit trail |
| Integrations | `id` | — | — | Integration configs (Slack, etc.) |

**Capacity mode:** On-demand (pay-per-request) for all tables. Switch to provisioned with auto-scaling if costs warrant it.

**SessionLogs TTL:**
The SessionLogs table has DynamoDB TTL enabled on the `ttl` attribute. Each log entry is written with a TTL of **7 days** from creation. After 7 days, DynamoDB automatically deletes the entry at no cost. Before TTL expiry, completed session logs are archived to S3 (see below). This ensures:
- DynamoDB storage stays small (only recent/active session logs)
- Costs don't grow unboundedly with session volume
- Archived logs remain accessible in S3 indefinitely

### S3

- Single bucket: `auto-harness-archives-{account-id}`
- Path structure: `sessions/{sessionId}/logs.jsonl`
- Completed sessions are archived from DynamoDB → S3, then DynamoDB log entries are deleted
- Lifecycle policy: transition to Infrequent Access after 30 days, Glacier after 90 days

### VPS Agent

A long-running Node.js process with these internal components:

```mermaid
graph LR
    subgraph "Auto-Harness Agent"
        Conn["Connection Manager<br/>WebSocket client"]
        Config["Config Loader<br/>JSON + env vars"]
        WTM["Worktree Manager<br/>git worktree lifecycle"]
        Runner["Session Runner<br/>orchestration"]
        Exec["Executor<br/>child_process + node-pty"]
        Log["Log Streamer<br/>buffer + emit"]
    end

    Conn <--> Runner
    Config --> WTM
    Config --> Conn
    Runner --> WTM
    Runner --> Exec
    Exec --> Log
    Log --> Conn
```

| Component | Responsibility |
|-----------|----------------|
| Connection Manager | WebSocket client with auto-reconnect (exponential backoff, max 60s). Sends/receives typed messages. |
| Config Loader | Reads `auto-harness-agent.config.json` and env vars. Validates configuration on startup. |
| Worktree Manager | Creates worktrees on startup if missing (`git worktree add`). Tracks status (idle/busy/error). Handles claim/release. |
| Session Runner | Orchestrates a session: claim worktree → run setup script → spawn command → monitor → report. |
| Executor | Wraps `child_process.spawn` with `node-pty` for PTY emulation. Handles process signals, exit codes, timeouts. |
| Log Streamer | Buffers stdout/stderr chunks, adds timestamps, emits via WebSocket. Rate-limits to avoid flooding. |

**Concurrency** = number of configured worktrees. Each worktree runs at most one session at a time.

### Next.js Web UI

Server-side rendered React application.

| Page | Purpose |
|------|---------|
| Dashboard | Active sessions, queue depth, connected agents, worktree utilization. "New Session" button opens prompt form. |
| Sessions | List with filters (status, repo, agent, source), create new, live detail view |
| Session Detail | Terminal-like log viewer (xterm.js) connected via WebSocket for real-time output. On page load, fetches historical logs via REST then switches to WebSocket for live tail. |
| Schedules | Create/edit/delete scheduled tasks, view run history, manual trigger |
| Repositories | Add, edit, remove repositories |
| Settings | Service accounts, API keys |

The **New Session form** allows users to create sessions directly from the browser with: repository selector, prompt textarea, agent/command picker (codex, claude, etc.), timeout (required), priority slider, and optional label filters. Submits via `POST /sessions` with `source: 'ui'`.

The UI connects to the REST API for CRUD and opens a WebSocket for live session log streaming.

---

## Data Flows

### Creating and Running a Session

```mermaid
sequenceDiagram
    participant CI as CI System
    participant API as API Gateway + Lambda
    participant DDB as DynamoDB
    participant Agent as VPS Agent
    participant CLI as AI CLI Tool
    participant UI as Web UI

    CI->>API: POST /sessions { repo, prompt, command }
    API->>DDB: Create session (status: queued)
    API->>DDB: Query idle worktrees matching labels
    DDB-->>API: worktree wt-1 available

    API->>Agent: WebSocket: session:assign
    Agent->>Agent: Claim worktree wt-1 (status: busy)
    Agent->>API: session:ack
    API->>DDB: Update session (status: running, worktreeId: wt-1)

    Agent->>Agent: Run setup script
    Agent->>CLI: Spawn: codex -p "Fix the test"

    loop Log streaming
        CLI-->>Agent: stdout/stderr output
        Agent->>API: WebSocket: session:log
        API->>DDB: Write to SessionLogs
        API->>UI: WebSocket: session:log (if subscribed)
    end

    CLI-->>Agent: Process exit (code 0)
    Agent->>API: WebSocket: session:status (completed, exitCode: 0)
    API->>DDB: Update session (status: completed)
    Agent->>Agent: Release worktree wt-1 (status: idle)
    API->>DDB: Check queued sessions for wt-1
```

### Agent Connection and Recovery

```mermaid
sequenceDiagram
    participant Agent as VPS Agent
    participant API as API Gateway + Lambda
    participant DDB as DynamoDB

    Agent->>API: WebSocket connect (?token=hns_xxx)
    API->>DDB: Validate token
    API->>DDB: Store Connection
    API-->>Agent: Connected

    Agent->>API: agent:register { agentId, worktrees }
    API->>DDB: Upsert worktree records
    API->>DDB: Query queued sessions matching worktrees
    API-->>Agent: session:assign (if pending)

    Note over Agent,API: Connection drops

    Agent->>Agent: Exponential backoff (1s, 2s, 4s... 60s)
    Agent->>API: Reconnect
    API->>DDB: Clean up old connection, store new
    Agent->>API: agent:register (re-report worktrees + in-progress sessions)
    API->>DDB: Reconcile state
```

### Running a Scheduled Update

```mermaid
sequenceDiagram
    participant CW as CloudWatch Events
    participant Lambda as Cron Lambda
    participant DDB as DynamoDB
    participant Sched as Scheduler Lambda
    participant Agent as VPS Agent

    CW->>Lambda: Trigger (every 60s)
    Lambda->>DDB: Query schedules where nextRunAt <= now
    DDB-->>Lambda: 1 schedule due (daily-update)
    Lambda->>DDB: Create session (type: scheduled, source: schedule)
    Lambda->>DDB: Update schedule (lastRunAt, nextRunAt)
    Lambda->>Sched: Invoke scheduler
    Sched->>Agent: WebSocket: session:assign (worktreeId: null)
    Agent->>Agent: Acquire main checkout lock
    Agent->>Agent: Run command on main checkout

    loop Log streaming
        Agent->>Sched: WebSocket: session:log
        Sched->>DDB: Write to SessionLogs
    end

    Agent->>Sched: session:status (completed)
    Agent->>Agent: Release main checkout lock
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| WebSocket over polling | Lower latency for task dispatch and log streaming. Real-time UI updates. |
| Worktree reuse over create/delete | Faster session startup. Avoids repeated git clone overhead. Setup scripts handle branch reset. |
| Labels on worktrees | Enables routing Codex sessions to Codex-configured worktrees, Claude to Claude worktrees. Similar to GitHub Actions runner labels. |
| No Docker for agent | The VPS is a trusted environment. Docker is available for AI agents to use within repos for development tasks. |
| PTY emulation (node-pty) | Some AI CLIs (Codex, Claude Code) require a TTY for proper interactive output. |
| Priority queue | CI failure fixes can jump ahead of lower-priority prompt-based sessions. |
| DynamoDB on-demand | Simplifies capacity management for unpredictable workloads. Sessions can be bursty. |
| Separate admin token from service account keys | Admin token is a simple bootstrap mechanism (env var). Service accounts are trackable, scopeable, revocable. |
| Non-worktree scheduled sessions | Maintenance tasks (deps, lint) run on main checkout to avoid wasting worktree slots. Serial per-repo locking prevents conflicts. |
| xterm.js for live logs | Full terminal emulation renders ANSI colors, progress bars, and interactive output from AI CLIs correctly. |
| Session source tracking | Distinguishes `api`, `ui`, `webhook`, `schedule` origins for audit and filtering. |
