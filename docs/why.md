# Why Auto Harness

## The problem

Coding agents are useful at a desk and awkward in a software factory.

- CI fails at 2 a.m.; the fix is obvious to a tool that can see the log, but nobody is online.
- The same maintenance work (deps, lint, hygiene) is either never done or burns senior time.
- “Just run the agent in CI” either hits **API-metered** pricing that does not match how you already pay, or needs an **Agent SDK** path that **subscription plans do not support**.
- Interactive CLI sessions do not queue: they need a human, a TTY ritual, and no durable queue.

You want the models you already pay for—on **subscription plans**—driving real work against real repos, with audit trails and concurrency, without re-architecting everything around per-token API billing.

## Why this shape

| Choice | Why |
|--------|-----|
| **CLI tools, not Agent SDKs** | Vendor **subscriptions** generally unlock the **interactive / CLI products**, not the programmatic Agent SDK / pure API agent stacks. To use subscription capacity for automation, you must drive the **non-interactive CLI** the same way a power user would—except unattended. |
| **Non-interactive mode** | Headless factory work has no human to click approve. Sessions spawn the CLI with print/non-interactive flags (and a PTY when the tool still expects a TTY), capture output, and exit with a status. See [agent.md](agent.md). |
| **Your VPS holds the tools and logins** | Subscription auth and git credentials stay on **your** machines. The control plane schedules and records; it does not become a second AI vendor account. See [security.md](security.md). |
| **Worktrees + queue** | Subscription seats and host RAM are finite. Pre-warmed worktrees and a priority queue turn “how many agents can we run?” into an operational knob, not a hope. |
| **Thin AWS control plane** | Coordination should cost cents. The expensive/scarce resource is **subscription usage and host capacity**, not DynamoDB. See [costs.md](costs.md). |

## What we are *not* optimizing for

- **API-key / pay-per-token agent farms** as the primary economic model (you can point a CLI at API keys if you want, but that is not the design center).
- Replacing your IDE chat for interactive pair-programming.
- Owning every repo’s GitHub policy (comment bots, publish, CI triage). Callers **fire and forget** via `POST /sessions`; humans follow **Slack** and/or **GitHub**—see [harness.md](harness.md).

## Outcome

Auto Harness exists so teams can **spend subscription plan capacity** on automated coding work—CI recovery, prompts, shepherds, schedules—via **non-interactive CLIs**, with a queue, visibility, and hosts they control.

Business impact and use cases (human-facing): root [README](../README.md).  
Money: [costs.md](costs.md).  
How it runs: [architecture.md](architecture.md).
