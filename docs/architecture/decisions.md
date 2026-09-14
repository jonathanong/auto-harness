# Design decisions

Why the system is this shape. Locked product decisions with “do not propose” columns live in
[plan.md](../plan.md) §1 (D1–D11). This page is the
cross-plane summary.

| Decision                                  | Why, in one line                                                                                 | See                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Two-plane split                           | Cloud stays secret-light and elastic; heavy/untrusted execution stays on the VPS                 | [README](README.md)                          |
| WebSocket over polling                    | Low-latency assign + log streaming                                                               | [websocket.md](../websocket.md)              |
| Worktree reuse                            | Fast start; checkout resets tracked state, setup scripts prepare the repo                        | [host-daemon.md](../host-daemon.md)          |
| Labels on worktrees                       | Route Codex vs Claude (etc.) like Actions runners                                                | [assignment.md](assignment.md)               |
| Match then round-robin                    | Filter repo / labels / online idle, then least-recently-assigned                                 | [assignment.md](assignment.md)               |
| No Docker wrapping the agent              | Trusted host; Docker optional **inside** repos                                                   | D9, [security.md](../security.md)            |
| PTY 120×40 for assigned CLIs (POSIX)      | Assigned AI CLIs need a TTY; git, setup, and hooks stay pipe-based                               | [host-daemon.md](../host-daemon.md)          |
| Prompt as argv/stdin, not a shell string  | Avoid injection from untrusted prompts                                                           | plan invariant 8                             |
| Priority queue + FIFO ties                | CI fixes can preempt batch work                                                                  | [assignment.md](assignment.md)               |
| DynamoDB on-demand                        | Bursty session traffic                                                                           | [aws.md](../aws.md)                          |
| Scheduled work on main checkout           | Maintenance without burning worktree slots; serial per repo                                      | [session-lifecycle.md](session-lifecycle.md) |
| Host-scoped workspace pools               | Non-git runs use pre-provisioned directories behind `allowedRoots`                               | [session-lifecycle.md](session-lifecycle.md) |
| Readable log document + optional xterm    | Pretty JSONL by default; raw 120×40 replay for ANSI/PTY output                                   | [logs.md](logs.md), [web.md](../web.md)      |
| Session `source`                          | Audit and filter by `api` / `ui` / `webhook` / `schedule`                                        | [api.md](../api.md)                          |
| Agent auto-update drains                  | Drain, finish in-flight CLIs, verify, stage, restart, roll back — no kill of running CLIs        | [host-daemon.md](../host-daemon.md)          |
| Principal session drains                  | Durable `CURRENT` fence blocks create/assign for one principal+repository                        | [aws.md](../aws.md)                          |
| Usage limits: account cooldown + fallback | Pause the assigned account, route to the next eligible target; providerless commands are ungated | D8, [assignment.md](assignment.md)           |
| Bounded infrastructure retry              | One retry for checkout-fetch or pre-launch host loss; a second eligible failure is terminal      | D10, [assignment.md](assignment.md)          |
| Resume prefers native placement           | Pin the source **host**, re-checkout `ref` in any eligible worktree there; else fresh-route      | D5, [assignment.md](assignment.md)           |
| Subscriptions via non-interactive CLI     | Cost path is vendor seats/quota, not API metering                                                | [why.md](../why.md), [costs.md](../costs.md) |
| Native harness invocation                 | Spawn each vendor’s own CLI — no intermediary Agent SDK                                          | [why.md](../why.md)                          |
| Repo harness fire-and-forget              | Callers `POST /sessions` and exit; Slack + agent GitHub writes are the feedback                  | D2, [harness.md](../harness.md)              |

## Related

[principles.md](principles.md) · [gotchas.md](gotchas.md) · [plan.md](../plan.md) · [comparison.md](../comparison.md)
