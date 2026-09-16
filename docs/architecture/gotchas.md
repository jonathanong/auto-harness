# Concerns and gotchas

Sourced traps. If a row is not already stated in `plan.md`, `aws.md`, `host-daemon.md`,
`websocket.md`, or `security.md`, it does not belong here.

When a flow changes, update the **layer** doc first, then the matching architecture chart.
[plan.md](../plan.md) remains the lockfile for D1–D11 and invariants 1–13. These pages must not
become a third source of truth.

## Maturity — do not overclaim

- Control plane + daemon are implemented and exercised locally (DynamoDB Local + local WebSockets).
- AWS deploy / update / REST health / teardown has an account-backed proof. That proof is
  disposable; it does not imply a standing production fleet.
- A long-running subscription-CLI fleet E2E against the hosted control plane has **not** been
  demonstrated. See [plan.md](../plan.md) Phase 3 status and
  [deploy-aws.md](../deploy-aws.md).

## If you are about to…

| Temptation                                                        | Why it is wrong                                                                                          | See                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Await host assignment inside `POST /sessions`                     | Browser and host never share a request lifetime                                                          | [request-lifetime.md](request-lifetime.md), plan inv. 12                |
| Scan Connections to talk to one host or one session’s viewers     | Same; use an indexed fan-out from a later invocation                                                     | [request-lifetime.md](request-lifetime.md)                              |
| Treat `postToConnection` / local `send()` as assigned or archived | A socket write is not a durable fact                                                                     | [principles.md](principles.md) #2, [websocket.md](../websocket.md)      |
| Add a server-originated WebSocket ping                            | Lambda has no process to hold the timer; keepalive is agent-initiated                                    | [connection.md](connection.md), [plan.md](../plan.md) §7                |
| Treat the 1-minute EventBridge rule as the work dispatcher        | Cron is a repair sweep; create/register/terminal assign immediately over WebSocket                       | [communication.md](communication.md)                                    |
| Auto-move a running session onto another host after disconnect    | Workspace state is on the original disk                                                                  | [connection.md](connection.md), [aws.md](../aws.md#disconnect-handling) |
| Retry a failed CLI / setup / timeout automatically                | At most one automatic retry, and only checkout-fetch or pre-launch `host_lost`                           | D10, [assignment.md](assignment.md)                                     |
| Wrap the agent or its worktrees in Docker / gVisor / podman       | Host is trusted; isolation is the CLI’s own sandbox                                                      | D9, [decisions.md](decisions.md), [security.md](../security.md)         |
| Detect `package.json` / lockfiles and run a package manager       | Daemon is package-manager-agnostic; setup scripts own install                                            | plan inv. 11                                                            |
| Require the host pane (`:7422`) for a management feature          | Control plane must do everything; host pane is debug-only                                                | plan inv. 10                                                            |
| Replay REST log history on the viewer socket                      | Viewer does not carry log text; optional `session:log-part` notify only                                  | plan inv. 13, [logs.md](logs.md)                                        |
| Use S3 multipart for 1-minute log parts                           | Minimum part size is 5 MB except the last part; PUT gzip objects instead                                 | [logs.md](logs.md)                                                      |
| Require the host pane to **read** a transcript                    | Control plane still polls S3; host pane is the live PTY debug stream                                     | plan inv. 10, [logs.md](logs.md)                                        |
| Put log bodies in DynamoDB SessionLogs                            | Bodies are S3; Dynamo holds archive pointers only                                                        | [logs.md](logs.md), [costs.md](../costs.md)                             |
| Stream every CLI chunk over control-plane WebSocket               | That path was ~$155/month; host PUT gzip parts instead                                                   | [costs.md](../costs.md)                                                 |
| Put git or AI vendor keys in the control plane                    | Secrets live on the VPS                                                                                  | [security.md](../security.md)                                           |
| Pass secrets through the prompt                                   | Prompts are stored in DynamoDB and visible in the UI                                                     | [security.md](../security.md)                                           |
| Concatenate prompt / `ref` into a shell string                    | No shell interpolation of untrusted input                                                                | plan inv. 8                                                             |
| Pin resume to a worktree and wait for it                          | Resume pins the **host**; the worktree may already have been reused                                      | D5, [assignment.md](assignment.md)                                      |
| Catch up cron occurrences skipped while a repo was closed         | Never catch up; not a bug                                                                                | [plan.md](../plan.md) admission                                         |
| Guess the archive bucket `auto-harness-archives-{account}`        | CDK generates a hashed name; read the stack output                                                       | [aws.md](../aws.md#s3-archival)                                         |
| Collect every cursor page in the UI                               | Pagination is a storage bound, not an in-memory slice                                                    | plan inv. 13                                                            |
| Use ruspty / PTY on Windows for the assigned CLI                  | POSIX only; Windows can run git / setup / hooks but not the assigned AI CLI                              | [host-daemon.md](../host-daemon.md), plan Phase 1                       |
| Ignore protocol / capability gating                               | Hosts must register protocol `7` with current capabilities; command-start and deferred hook are required | [websocket.md](../websocket.md)                                         |
| Treat archive metadata as the log body                            | DynamoDB holds pointers / retry state only                                                               | [logs.md](logs.md), principle 6                                         |
| Design a required outbound-webhook callback for CI                | Callers `POST /sessions` and exit; Slack + agent GitHub writes are the feedback                          | D2, [harness.md](../harness.md)                                         |
| Promise exactly-once GitHub effects after host loss               | Duplicate delivery is assumed; ambiguous loss needs an explicit retry                                    | principle 4                                                             |
| Let a viewer or Slack outage stall host ingestion                 | Observability may fall behind; execution must not                                                        | principle 7                                                             |

Prompts are attacker-influenced (issue comments, CI logs). Named catalog commands, scoped git
tokens, and agent-held credentials bound the blast radius; they do **not** protect a fully
compromised host or a malicious Command definition. See [security.md](../security.md#threat-model-prompt-influence).

## Related

[principles.md](principles.md) · [decisions.md](decisions.md) · [plan.md](../plan.md) · [security.md](../security.md)
