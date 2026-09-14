# Architecture principles

These eight rules govern implementation choices across both planes. AWS service choices and vendor
capabilities are constraints or implementation decisions; they may change without changing these
rules.

Canonical wording lives here. [plan.md §5](../plan.md#5-invariants) is a **different** list: thirteen
testable invariants with numbered acceptance tests. Do not merge the two.

| #   | Principle                                          | Means in practice                                                                                  | Forbids                                                                               |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Each fact has one authoritative owner              | Control plane owns admission, desired work, and leases. Hosts report process and filesystem facts. | Using Lambda memory as source of truth                                                |
| 2   | An acknowledgement names one durable fact          | Accepted, assigned, running, finished, and transcript archived are separate facts.                 | Treating a successful socket write as any of those                                    |
| 3   | Commit intent before external effects              | Persist commands and notification jobs atomically with the state change that created them.         | Fire-and-forget side effects that have no durable row to retry                        |
| 4   | Assume duplicate delivery and uncertain execution  | Fence messages by attempt identity; make processing idempotent.                                    | Exactly-once promises to GitHub or another external system                            |
| 5   | Operational work scales with active work and bytes | Heartbeats, scheduling, recovery, and log reads use bounded access paths.                          | Letting retained terminal history raise the cost of routine work                      |
| 6   | Match storage to purpose                           | DynamoDB: compact coordination + temporary log staging. S3: verified transcript history.           | Storing large prompts or frozen command snapshots on frequently updated lease records |
| 7   | Observability cannot interfere with execution      | Browser and notification delivery may fall behind.                                                 | Delaying host ingestion, assignment, cancellation, or terminal reports for a viewer   |
| 8   | Retention and completeness are product contracts   | Archived means expected bytes were verified and an authorized reader can retrieve them.            | Collapsing truncated, incomplete, unavailable, and expired into one “missing” state   |

Principle 4’s one automatic infrastructure retry is D10: a checkout-fetch failure whose reporting
attempt proves its terminal hook was deferred, or a host loss proven to precede the v4 command-start
acknowledgement. Post-launch and ambiguous loss is terminal. Before command authorization, a terminal
hook is deferred until the control plane durably decides the attempt’s disposition, so a lost status
cannot replay an already-run escalation hook. See [assignment.md](assignment.md).

## Map onto plan.md invariants

The eight principles and the thirteen plan invariants are not the same list. This table is a
cross-walk, not a substitute for [plan.md §5](../plan.md#5-invariants).

| Principle                         | Related plan invariants                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1 Fact owner                      | 1 exclusive worktree claim, 3 one live connection per agent, 9 `concurrencyId`                  |
| 2 Named acknowledgement           | 2 assign has a deadline                                                                         |
| 3 Commit intent before effects    | 4 schedule fires at most once per `nextRunAt`; durable notification outbox                      |
| 4 Duplicate delivery              | 2 ack deadline; [plan.md](../plan.md) D10 bounded retry                                         |
| 5 Work scales with active work    | 13 list/history page at storage; sparse active-host index                                       |
| 6 Match storage to purpose        | SessionLogs vs S3 archives — [logs.md](logs.md)                                                 |
| 7 Observability must not block    | 12 browser and host never share a request lifetime — [request-lifetime.md](request-lifetime.md) |
| 8 Retention is a product contract | Archived = verified bytes; truncated / unavailable / expired stay distinct                      |

Other plan invariants that are not a restatement of these eight: 5 log ordering, 6 `usage_limit`
routing, 7 native resume pin, 8 no shell interpolation, 10 control plane does everything, 11
package-manager-agnostic orchestration, 13 pagination (also listed under principle 5).

## Related

[decisions.md](decisions.md) · [gotchas.md](gotchas.md) · [plan.md](../plan.md) · [security.md](../security.md)
