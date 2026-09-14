# Why Auto Harness

Product page: [root README](../README.md). Money: [costs.md](costs.md). How it runs: [architecture/](architecture/README.md).

## What it is

Auto Harness is two planes:

| Plane             | What it is                                                        | Idle cost                                                |
| ----------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| **Control plane** | Web UI, REST/webhooks, session queue, assignment, logs, schedules | Serverless AWS — scales to zero when nothing is running  |
| **Host plane**    | Daemon on a VPS, laptop, or any machine you provision             | The machine itself. Zero hosts is valid; work just waits |

The control plane never becomes a second AI vendor account. The host plane holds the CLIs, git credentials, and vendor logins. Former docs called the host plane the “execution plane.”

Do not confuse **host plane** (the daemon/machine layer) with **host pane** (the debug-only local UI on `:7422`). [terminology.md](terminology.md).

## The problem

Coding agents are useful at a desk and awkward in a software factory.

- CI fails at 2 a.m.; the fix is obvious to a tool that can see the log, but nobody is online.
- The same maintenance work (deps, lint, hygiene) is either never done or burns senior time.
- “Just run the agent in CI” usually means **API-metered** pricing that does not match how you already pay, or wrapping the CLI in a vendor SDK/harness that lags behind the CLI's own releases and features.
- Interactive CLI sessions do not queue: they need a human, a TTY ritual, and no durable queue.

You want the models you already pay for—on **subscription plans**—driving real work against real repos, with audit trails and concurrency, without re-architecting everything around per-token API billing.

## Why this shape

| Choice                                   | Why                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Native CLI, no intermediary harness**  | Auto Harness spawns each vendor's own CLI directly—no Agent SDK, no universal harness in between. That is the interface every vendor ships, documents, and supports for unattended use, and it does not change when a vendor revisits its SDK or subscription licensing (some CLIs have no SDK at all; where one exists, it typically wraps the same CLI binary anyway). |
| **Non-interactive mode**                 | Headless factory work has no human to click approve. Sessions spawn the CLI with print/non-interactive flags (and a PTY when the tool still expects a TTY), capture output, and exit with a status. See [host-daemon.md](host-daemon.md).                                                                                                                                |
| **Your host holds the tools and logins** | Subscription auth and git credentials stay on **your** machines. The control plane schedules and records; it does not become a second AI vendor account. See [security.md](security.md), [auth.md](auth.md).                                                                                                                                                             |
| **Worktrees + queue**                    | Subscription seats and host RAM are finite. Pre-warmed worktrees and a priority queue turn “how many agents can we run?” into an operational knob, not a hope.                                                                                                                                                                                                           |
| **Thin serverless control plane**        | Coordination should cost cents and idle at zero. The expensive/scarce resource is **subscription usage and host capacity**, not DynamoDB. See [costs.md](costs.md).                                                                                                                                                                                                      |

## What it does and does not

| Does                                                                          | Does not                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue non-interactive CLI sessions (priority, labels, concurrency, resume)    | Interactive / human-in-the-loop driving — no pairing TTY, no in-browser IDE, no multiplayer session                                                                 |
| Trigger work from the API, GitHub Actions, GitHub App mentions, and schedules | Hold or mint provider tokens, git credentials, or SSH keys — those stay on the host. Do not put secrets in prompts; prompts are stored and visible operationally    |
| Run on a serverless control plane that scales to zero                         | Care which agent harness you use — every session is a catalog Command (fixed argv). Register Codex, Claude Code, Grok, or any other CLI                             |
| Observe live logs, history, and (optional) Slack lifecycle                    | Own the target repo’s GitHub policy, prompt templates, or review workflow — that is the repo harness plus [pr-shepherd](https://github.com/jonathanong/pr-shepherd) |

Sessions target a **named catalog Command**, not a free-form shell string (plan D4). Operators can register any CLI; callers cannot send arbitrary argv through the API. Native usage-limit adapters exist for `claude` / `codex` / `gemini` / `grok`; unknown CLIs still run, they just do not get vendor-specific quota parsing.

There is no required outbound callback webhook (plan D2). Callers `POST /sessions` and exit.

Competitive non-goals (sandboxes, Cloudflare, human-in-the-loop surfaces): [comparison.md](comparison.md#deliberate-non-goals). Locked product non-goals: [plan.md](plan.md#2-non-goals).

## Why autonomous companions

A session has no human at the keyboard. Auto Harness queues and runs the CLI; it does not invent the agent-side loop that unattended work needs. Install these on the host or in the target repo:

| Companion                                                               | Why an autonomous session needs it                                                                                         |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **[agent-blackboard](https://github.com/jonathanong/agent-blackboard)** | Session-scoped notes the next tick can read. Thinking is not sitting in a TTY, and logs omit a lot of the thought process. |
| **[pr-shepherd](https://github.com/jonathanong/pr-shepherd)**           | Deterministic gather-and-act on CI and review comments. Nobody is watching the PR.                                         |
| **[no-mistakes](https://github.com/jonathanong/no-mistakes)**           | Local AST graph and test selector, so the agent does not grep or guess.                                                    |

Repo-side hookup (when to dispatch, prompt files, `/pr-shepherd` patterns): [harness.md](harness.md).

## What we are not optimizing for

- **API-key / pay-per-token agent farms** as the primary economic model (you can point a CLI at API keys if you want, but that is not the design center).
- Replacing your IDE chat for interactive pair-programming.
- Owning every repo’s GitHub policy (comment bots, publish, CI triage). Callers **fire and forget** via `POST /sessions`; humans follow **Slack** and/or **GitHub**—see [harness.md](harness.md).
- Multiplayer sessions, presence, or an in-browser IDE/terminal for humans to co-drive a session. Auto Harness is autonomous by design: a human's role is to dispatch work and read the result, not sit in the loop with the agent.
- Scaling the **host** fleet to zero. The control plane is serverless; hosts are always-on capacity you provision. That is why there is a queue. See [comparison.md](comparison.md#roads-not-taken-managed-agent-sandboxes).

## Outcome

Auto Harness exists so teams can **spend subscription plan capacity** on automated coding work—CI recovery, prompts, shepherds, schedules—via **non-interactive CLIs**, with a queue, visibility, and hosts they control.
