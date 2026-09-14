# Session lifecycle

How a session is created, placed, run, and finished. Assignment detail: [assignment.md](assignment.md).
Agent internals: [host-daemon.md](../host-daemon.md#session-lifecycle-agent-view). Scheduler:
[aws.md](../aws.md#scheduler).

## Session kinds

|                 | Prompt                          | Scheduled                          | Workspace                              |
| --------------- | ------------------------------- | ---------------------------------- | -------------------------------------- |
| Placement       | Labeled worktree                | Main checkout (`worktreeId: null`) | Pool slot                              |
| Host capability | —                               | `scheduled-main-checkout`          | `workspace-sessions`                   |
| Git             | Checkout `ref` (branch/tag/SHA) | Branch-name `ref` only             | None (`repositoryId: null`)            |
| Resume          | Yes (host pin, not worktree)    | No                                 | No (clone is allowed)                  |
| Concurrency     | 1 per worktree                  | Serial per repo on that host       | 1 per slot                             |
| Cleanup         | Worktree reset                  | Release main-checkout lock         | Optional; failure quarantines the slot |

Workspace sessions reject `ref`, non-empty `requiredLabels`, and raw setup scripts. They run host
setup plus a trusted setup profile. Missing or unsafe paths fail the existing non-empty
`allowedRoots` realpath check. Cleanup failure is `workspace_cleanup_failed`.

## Create and run (prompt)

```mermaid
sequenceDiagram
    participant CI as CI / UI
    participant API as Control plane
    participant DDB as DynamoDB
    participant Agent as VPS agent
    participant Tool as AI CLI
    participant UI as Web UI

    CI->>API: POST /sessions
    API->>DDB: Create session queued
    API->>Agent: session:assign
    Agent->>Agent: Claim worktree
    Agent->>API: session:ack
    API->>DDB: status running
    Agent->>Agent: Setup script
    Agent->>Tool: Spawn argv, no shell
    loop Logs
        Tool-->>Agent: output
        Agent->>API: session:log
        API->>DDB: SessionLogs
        API->>UI: session:log if subscribed
    end
    Tool-->>Agent: exit
    Agent->>API: session:status
    API->>DDB: terminal, free worktree, drain queue
```

The control plane chooses the worktree (match then round-robin). The agent does not pull a global
queue — it only accepts `session:assign` and reports idle so the next session can drain.

## Control-plane status

```mermaid
stateDiagram-v2
    [*] --> queued: POST /sessions
    queued --> running: ack received
    queued --> queue_expired: queueExpiresAt
    running --> completed: exit 0
    running --> failed: nonzero exit or setup fail
    running --> cancelled: cancel
    running --> timed_out: timeout
    running --> queued: usage_limit cooldown plus fallback
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
    timed_out --> [*]
    queue_expired --> [*]
```

`usage_limit` is not a logical-session finish: the account is paused, the worktree is released, and
the session stays queued for the next eligible target until `queueExpiresAt`. See D8.

## Agent view

```mermaid
stateDiagram-v2
    [*] --> Assigned: assign
    Assigned --> ClaimWorktree: worktreeId set
    Assigned --> AcquireLock: worktreeId null
    ClaimWorktree --> Setup: claimed
    AcquireLock --> Setup: lock held
    Setup --> Running: setup ok
    Setup --> Failed: setup fail
    Running --> Completed: exit 0
    Running --> Failed: exit != 0
    Running --> TimedOut: timeout
    Running --> Cancelled: cancel
    Completed --> [*]
    Failed --> [*]
    TimedOut --> [*]
    Cancelled --> [*]
```

## Scheduled (main checkout)

```mermaid
sequenceDiagram
    participant EB as EventBridge
    participant Cron as Cron Lambda
    participant DDB as DynamoDB
    participant Sched as Scheduler
    participant Agent as VPS agent

    EB->>Cron: every 60s
    Cron->>DDB: due schedules
    Cron->>DDB: create session type=scheduled
    Cron->>Sched: assign
    Sched->>Agent: session:assign worktreeId=null
    Agent->>Agent: main checkout lock + command
    Agent->>Sched: logs + status
```

Only agents advertising `scheduled-main-checkout` are eligible, so daemon support can roll out
before the scheduler emits null-worktree assignments. The one-minute EventBridge rule is a **repair
sweep**, not the primary dispatcher — create/register/terminal also invoke the scheduler.

Details: [aws.md — Cron](../aws.md#cron-evaluator), [host-daemon.md — Non-worktree](../host-daemon.md#non-worktree-sessions-scheduled).

## Workspace

```mermaid
sequenceDiagram
    participant API as Control plane
    participant DDB as DynamoDB
    participant Agent as VPS agent
    participant Slot as Host slot

    API->>DDB: Create session type=workspace
    API->>DDB: Idle slot on workspace-sessions host
    API->>Agent: session:assign slot + setupProfileId
    Agent->>Slot: Claim, skip git
    Agent->>API: session:ack
    Agent->>Agent: Host setup + trusted profile
    Agent->>Agent: Spawn command
    Agent->>API: logs + status
    opt destroyWorkspaceAfter
        Agent->>Slot: Clean
        alt cleanup fails
            Agent->>API: workspace_cleanup_failed
            Note over Slot: quarantined until safe
        end
    end
```

## Related

[assignment.md](assignment.md) · [connection.md](connection.md) · [logs.md](logs.md) · [api.md](../api.md)
