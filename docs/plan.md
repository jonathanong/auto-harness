# Implementation Plan

## Project Structure

```
auto-harness/
├── packages/
│   ├── cdk/                    # AWS CDK infrastructure
│   │   ├── lib/
│   │   │   ├── auto-harness-stack.ts
│   │   │   ├── api-gateway.ts
│   │   │   ├── lambda.ts
│   │   │   ├── dynamodb.ts
│   │   │   └── s3.ts
│   │   └── bin/
│   │       └── auto-harness.ts
│   │
│   ├── api/                    # Lambda functions (REST + WebSocket)
│   │   ├── src/
│   │   │   ├── handlers/
│   │   │   │   ├── rest/
│   │   │   │   │   ├── sessions.ts
│   │   │   │   │   ├── repositories.ts
│   │   │   │   │   ├── worktrees.ts
│   │   │   │   │   └── auth.ts
│   │   │   │   └── websocket/
│   │   │   │       ├── connect.ts
│   │   │   │       ├── disconnect.ts
│   │   │   │       └── message.ts
│   │   │   ├── services/
│   │   │   │   ├── session-service.ts
│   │   │   │   ├── scheduler.ts
│   │   │   │   └── notification.ts
│   │   │   └── db/
│   │   │       └── client.ts
│   │   └── package.json
│   │
│   ├── agent/                  # VPS service (Node.js daemon)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── connection.ts
│   │   │   ├── executor.ts
│   │   │   ├── worktree-manager.ts
│   │   │   ├── session-runner.ts
│   │   │   ├── log-streamer.ts
│   │   │   └── config.ts
│   │   └── package.json
│   │
│   ├── web/                    # Next.js Web UI
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── layout.tsx
│   │   │   │   ├── page.tsx
│   │   │   │   ├── sessions/
│   │   │   │   ├── repositories/
│   │   │   │   └── settings/
│   │   │   ├── components/
│   │   │   └── lib/
│   │   │       └── api-client.ts
│   │   └── package.json
│   │
│   └── shared/                 # Shared types, constants, utilities
│       ├── src/
│       │   ├── types.ts
│       │   ├── constants.ts
│       │   └── validation.ts
│       └── package.json
│
├── docs/
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
└── README.md
```

## Data Model

```mermaid
erDiagram
    User {
        string id PK
        string username "unique"
        string passwordHash "bcrypt, null for service accounts"
        string role "admin | operator | read-only"
        string type "user | service-account"
        string apiKeyHash "SHA-256, service accounts only"
        string[] allowedRepositories "optional scope"
        string createdAt
    }

    Repository {
        string id PK
        string name
        string url
        string defaultBranch
        string setupScript "optional"
        string slackChannel "optional override"
        string createdAt
    }

    Worktree {
        string id PK
        string agentId FK
        string repositoryId FK
        string path
        string[] labels "e.g. codex, claude"
        string status "idle | busy | error"
        string setupScript "optional"
        string currentSessionId FK "nullable"
    }

    Session {
        string id PK
        string repositoryId FK
        string worktreeId FK "nullable until assigned"
        string userId FK
        string prompt
        string command "e.g. codex -p"
        string status "queued | running | completed | failed | cancelled | timed_out"
        string type "prompt | scheduled"
        string source "api | ui | webhook | schedule"
        number timeout "seconds, required"
        number priority
        string[] requiredLabels
        number exitCode "nullable"
        string slackThreadTs "nullable"
        string slackChannel "nullable"
        string createdAt
        string startedAt
        string completedAt
    }

    Schedule {
        string id PK
        string repositoryId FK
        string name
        string command
        string cron "5-field cron expression"
        boolean enabled
        number timeout "seconds"
        string lastRunAt "nullable"
        string nextRunAt
        string createdAt
    }

    SessionLog {
        string sessionId PK
        number timestamp SK
        string stream "stdout | stderr | system"
        string content
        number ttl "DynamoDB TTL, auto-delete after expiry"
    }

    Connection {
        string connectionId PK
        string type "agent | client"
        string agentId "nullable"
        string boundAgentId "required for agent type, validated on register"
        string userId "nullable"
        string connectedAt
    }

    AuditLog {
        string id PK
        string timestamp SK
        string userId
        string action "e.g. session:create, account:delete"
        string resourceId
        string metadata "IP, user agent"
    }

    Integration {
        string id PK "e.g. slack"
        string type "slack"
        string encryptedConfig "KMS-encrypted bot token + settings"
        string defaultChannel
        boolean enabled
    }

    User ||--o{ Session : creates
    Repository ||--o{ Worktree : has
    Repository ||--o{ Session : targets
    Repository ||--o{ Schedule : has
    Schedule ||--o{ Session : creates
    Worktree ||--o| Session : runs
    Session ||--o{ SessionLog : produces
```

## Phases

### Phase 1 — Foundation

> Get one session running end-to-end on the local agent, no cloud.

- Initialize pnpm monorepo with workspaces
- Set up `packages/shared` with types and constants
- Build `packages/agent`:
  - Config loading (repos, worktrees, labels) from JSON file + env vars
  - Git worktree manager — create worktrees on startup, validate existing ones
  - Process executor — `child_process.spawn` with `node-pty` for PTY emulation
  - Session runner — claim worktree → run setup script → spawn command → collect output → release
  - Session timeout — kill process after `timeout` seconds, report `timed_out` status
  - Log streamer — buffer and emit stdout/stderr with timestamps
- Minimal agent CLI: `auto-harness-agent start`, `auto-harness-agent status`
- **Local API server** (`packages/api/src/local-server.ts`) — Express + `ws` wrapper around the same Lambda handlers. Serves REST API on `localhost:7420` and WebSocket on `ws://localhost:7420/ws`. Connects to DynamoDB Local. Auto-creates tables and seeds a default admin on first start.
- Local-only mode for testing (accept sessions via local file or stdin)
- The full local stack: DynamoDB Local (Docker) + local API server + `packages/web` Next.js dev server + agent — all using the same code as production
- **Testing setup**:
  - vitest as test runner across all packages
  - Unit tests for session runner, worktree manager, config loader
  - Mock `child_process.spawn` / `node-pty` for executor tests
  - `packages/shared` types tested with type-level assertions

### Phase 2 — Cloud Infrastructure + API

- `packages/cdk` — AWS CDK stack:
  - DynamoDB tables (Users, Repositories, Sessions, Schedules, Connections, SessionLogs, AuditLogs, Integrations)
  - SessionLogs table with DynamoDB TTL enabled (`ttl` attribute) — auto-delete logs after 7 days
  - S3 bucket for archives
  - API Gateway (REST + WebSocket)
  - Lambda functions with appropriate IAM roles
  - CloudWatch Events rule (1-minute interval) for cron schedule evaluation
- `packages/api` — REST handlers:
  - Auth: login/logout, user CRUD, service account CRUD
  - Sessions: create (with `timeout` required), list (with `search` query param), get, cancel, clone
  - Repositories: CRUD
  - Worktrees: list, get
  - Agents: list, get
  - Schedules: CRUD + manual trigger (`POST /schedules/:id/trigger`)
  - Integrations: Slack config CRUD
- `packages/api` — WebSocket handlers:
  - `$connect` / `$disconnect` — validate token, manage Connections table
  - `$connect` — for agent connections, validate `boundAgentId` matches API key
  - `$default` — route messages by `type` field
  - Task dispatch — push `session:assign` to agent
  - Status/log forwarding — agent → DynamoDB, agent → subscribed clients
  - Live log replay — buffer last 100 lines per session, replay on `session:subscribe`
- `packages/api` — Cron handler:
  - Triggered by CloudWatch Events every minute
  - Queries Schedules table for due tasks (`nextRunAt <= now` and `enabled: true`)
  - Creates sessions with `type: 'scheduled'`, `source: 'schedule'`
  - Updates `lastRunAt` and computes `nextRunAt`
  - Stale session detection — sessions `running` longer than `timeout` with no heartbeat, mark `timed_out`
- **Local development**:
  - DynamoDB Local via Docker (`amazon/dynamodb-local`) for offline development
  - `packages/api` can run locally via SAM Local or a thin Express wrapper
  - Mock WebSocket server for agent development (`packages/agent/src/mock-server.ts`)
  - `.env.example` templates for all packages
- **Testing**:
  - Integration tests for DynamoDB operations using DynamoDB Local
  - API handler tests with mocked DynamoDB client
  - WebSocket handler tests with mock API Gateway Management API

### Phase 3 — Agent ↔ Cloud Integration

- Agent WebSocket client — connect to API Gateway, auto-reconnect with exponential backoff (max 60s)
- `agent:register` on connect — send worktree inventory, validated against `boundAgentId` on service account
- Task receipt and acknowledgment protocol
- Live log streaming over WebSocket (batched writes to DynamoDB via `BatchWriteItem`)
- Session status lifecycle: `queued → running → completed | failed | cancelled | timed_out`
- Session timeout — agent kills process after `timeout` seconds, reports `timed_out`
- Queue management with priority in Lambda scheduler
- Worktree label matching — session `requiredLabels` matched against worktree `labels`
- Reconnection recovery — re-report running sessions and worktree state
- Non-worktree session execution — run `scheduled` type sessions on main repo checkout
- Main checkout locking — serial execution per repository (one scheduled session at a time)
- **Testing**:
  - E2E test: create session → agent picks up → runs → completes (using DynamoDB Local + mock WebSocket)

### Phase 4 — Web UI

- `packages/web` — Next.js app:
  - Dashboard:
    - Active sessions, queue depth, connected agents, worktree utilization
    - Quick "New Session" button — opens prompt form directly from dashboard
    - Empty states with onboarding guidance for first-time users
    - Error banners (WebSocket disconnect, agent offline)
  - Session management:
    - **Search** — full-text search across session prompts (debounced, uses `search` query param)
    - **Create session form**: repo selector, prompt textarea, agent/command picker, timeout (required), priority slider, label filters, submit via `POST /sessions` with `source: 'ui'`
    - Session list with filters (status, repo, agent type, source) + sort (latest, priority)
    - **Live session detail** — terminal-like log viewer (xterm.js) connected via WebSocket for real-time output. On page load, fetches historical logs via REST, then switches to WebSocket for live tail.
    - Real-time status indicators (animated state badges, including `timed_out`)
    - Cancel session
    - **Re-run** — clone session as-is via `POST /sessions/:id/clone`
    - **Clone & Edit** — pre-fill new session form with existing session’s fields
    - Loading skeletons, error toasts, empty states
  - Schedule management:
    - Create/edit/delete scheduled tasks (cron builder UI)
    - View schedule history (past runs with status)
    - Manual trigger button
  - Repository management: add, edit, remove
  - Settings: service accounts, API keys, worktree configuration
  - Auth:
    - Login page (username + password, session cookie)
    - Admin accounts from `HARNESS_ADMINS` env var
    - User account management (admin creates users)
    - Password change
  - Slack integration:
    - Configure Slack bot token + default channel
    - Thread per session — created on queue, updated on start/complete/fail
    - Per-repository channel overrides
    - Last lines of stderr in failure thread reply

### Phase 5 — Polish + Advanced Features

- Session archival — move completed session logs from DynamoDB to S3
- GitHub webhook triggers — create session on CI failure, PR comment, etc.
- PR shepherding — watch PR, re-run agent on review comments
- Multi-agent pipelines — chain sessions (e.g., codex fix → claude review)
- Email notifications via SES
- Custom outbound webhooks
- Agent health monitoring — heartbeat, auto-restart detection
- Rate limiting + cost tracking
- Audit logging
