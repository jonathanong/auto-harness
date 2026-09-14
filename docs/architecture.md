# Architecture

Cross-plane architecture now lives in **[architecture/](architecture/README.md)**.

| Page                                                                   | What it explains                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------- |
| [architecture/README.md](architecture/README.md)                       | Two-plane overview + layer map                      |
| [architecture/principles.md](architecture/principles.md)               | Eight rules that survive a vendor change            |
| [architecture/decisions.md](architecture/decisions.md)                 | Why the system is this shape                        |
| [architecture/session-lifecycle.md](architecture/session-lifecycle.md) | Create → run → terminal; session kinds              |
| [architecture/assignment.md](architecture/assignment.md)               | Match, round-robin, ack, resume, bounded retry      |
| [architecture/connection.md](architecture/connection.md)               | Register, keepalive, disconnect, drain              |
| [architecture/communication.md](architecture/communication.md)         | WebSocket vs the 1-minute cron; what invokes Lambda |
| [architecture/logs.md](architecture/logs.md)                           | S3 gzip parts; CP poll; host-pane live stream       |
| [architecture/request-lifetime.md](architecture/request-lifetime.md)   | Browser and host never share a request              |
| [architecture/gotchas.md](architecture/gotchas.md)                     | Traps, maturity, “do not improve this”              |

Layer internals stay in [aws.md](aws.md) and [host-daemon.md](host-daemon.md). Locked decisions
stay in [plan.md](plan.md).

## Architecture principles

Canonical text: **[architecture/principles.md](architecture/principles.md)**.

These principles govern implementation choices across both planes. AWS service choices and vendor
capabilities are constraints or implementation decisions; they may change without changing these
rules.

1. **Each fact has one authoritative owner.**
2. **An acknowledgement names one durable fact.**
3. **Commit intent before external effects.**
4. **Assume duplicate delivery and uncertain execution.**
5. **Operational work scales with active work and new bytes.**
6. **Match storage to purpose.**
7. **Observability cannot interfere with execution.**
8. **Retention and completeness are product contracts.**
