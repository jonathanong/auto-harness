# Architecture

Cross-plane overview. Layer internals: [aws.md](../aws.md) (control), [host-daemon.md](../host-daemon.md) (execution). Locked decisions: [plan.md](../plan.md).

| Page                                         | What it explains                                        |
| -------------------------------------------- | ------------------------------------------------------- |
| [principles.md](principles.md)               | Eight rules that survive a vendor change                |
| [decisions.md](decisions.md)                 | Why the system is this shape                            |
| [session-lifecycle.md](session-lifecycle.md) | Create → run → terminal; prompt / scheduled / workspace |
| [assignment.md](assignment.md)               | Match, round-robin, ack, resume, bounded retry          |
| [connection.md](connection.md)               | Register, keepalive, disconnect, drain                  |
| [logs.md](logs.md)                           | Live tail, REST history, S3 archive                     |
| [request-lifetime.md](request-lifetime.md)   | Browser and host never share a request                  |
| [gotchas.md](gotchas.md)                     | Traps, maturity, “do not improve this”                  |

> **Maturity:** control-plane and daemon behavior is implemented and exercised locally with
> DynamoDB Local and local WebSockets. The AWS deploy, update, REST health, and teardown
> lifecycle has also passed an account-backed proof. Diagrams describe the deployable cloud
> topology; no permanent production environment is implied by that disposable proof.

## Two planes

| Plane               | Where                                                        | Doc                                     |
| ------------------- | ------------------------------------------------------------ | --------------------------------------- |
| **Control plane**   | Target: AWS — API Gateway, Lambda, DynamoDB, S3, EventBridge | **[aws.md](../aws.md)**                 |
| **Execution plane** | VPS — Node.js agent, git worktrees, AI CLIs                  | **[host-daemon.md](../host-daemon.md)** |

```mermaid
graph TB
    subgraph "Control Plane (AWS)"
        APIGW["API Gateway<br/>REST + WebSocket"]
        Lambda["Lambda<br/>Handlers + Scheduler"]
        DDB["DynamoDB"]
        S3["S3 archives"]
    end

    subgraph "Clients"
        WebUI["Next.js Web UI"]
        CI["CI/CD Systems"]
        CLI["CLI / Scripts"]
    end

    subgraph "Execution Plane (VPS)"
        Agent["Auto-Harness Agent"]
        subgraph "Worktrees"
            WT1["wt-1"]
            WT2["wt-2"]
            WT3["wt-3"]
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

Today those control-plane behaviors also run in the local API. Transcript bytes live in S3 when
`ARCHIVE_BUCKET` is set; DynamoDB keeps bounded archive metadata — see [logs.md](logs.md).

## Who owns what

| Plane     | Owns                                                                                         | Does not own                         |
| --------- | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| Control   | Auth, session records, queue, assignment, log fan-out, archive metadata, cron, notifications | Git credentials, SSH, AI vendor keys |
| Execution | Worktrees/slots on disk, process spawn, output streaming, git + AI secrets                   | Admission, desired work, leases      |

```mermaid
flowchart LR
    subgraph Control["Control plane"]
        H["password / API-key hashes"]
        P["session metadata + prompts"]
        K["KMS-wrapped Slack config"]
    end

    subgraph Exec["Execution plane (VPS)"]
        G["git / SSH credentials"]
        A["AI vendor keys"]
        D["worktrees, slots, CLI processes"]
    end

    Control -->|"schedule + observe"| Exec
```

Trust-boundary detail: [security.md](../security.md).

## Layer map

| Topic                  | Control plane                                                                                              | Execution plane                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Public API & auth      | [api.md](../api.md), [websocket.md](../websocket.md), [auth.md](../auth.md), [security.md](../security.md) | API key over WSS ([cli.md](../cli.md) / [local-development.md](../local-development.md)) |
| Session queue / assign | Scheduler + round-robin — [assignment.md](assignment.md)                                                   | Accepts `session:assign` only                                                            |
| Worktrees              | DynamoDB inventory + online flags                                                                          | Create / claim / release on disk                                                         |
| Workspace pools/slots  | Pool/profile records + host path-only attachments                                                          | Claim/release host-local non-git directories; realpath under `allowedRoots`              |
| Logs                   | SessionLogs + UI fan-out + S3 JSONL; Archives stores pointers — [logs.md](logs.md)                         | Assigned-command PTY + pipe-based setup/hooks, each `session:log`                        |
| Schedules              | EventBridge cron → sessions                                                                                | Main-checkout lock + run command                                                         |
| Secrets                | No repo/AI secrets                                                                                         | `.env`, SSH, vendor keys                                                                 |
| UI                     | Hosted clients → REST/WS — [web.md](../web.md)                                                             | Host pane is debug-only                                                                  |

Compatibility stub for the old blob URL and `#architecture-principles`:
[../architecture.md](../architecture.md).

## Related

| Doc                      | Role                     |
| ------------------------ | ------------------------ |
| [why.md](../why.md)      | Product rationale        |
| [costs.md](../costs.md)  | Subscription vs AWS cost |
| [plan.md](../plan.md)    | Phases + data model      |
| [gotchas.md](gotchas.md) | Traps and maturity       |
