# Auto Harness

Auto Harness is a two-plane system for running autonomous CLI agents: a serverless **control plane** (web UI + queue + API) and a **host plane** (a daemon on a VPS, laptop, or any machine you control).

You keep control of secrets and machines. Auto Harness queues the work, assigns it, and records what ran.

---

## What it is

| Plane             | What it is                                                        | Owns                                                     | Idle cost                   |
| ----------------- | ----------------------------------------------------------------- | -------------------------------------------------------- | --------------------------- |
| **Control plane** | Web UI, REST/webhooks, session queue, assignment, logs, schedules | Auth, catalog, queue, observation                        | Serverless — scales to zero |
| **Host plane**    | `auto-harness-agent` on a machine you provision                   | Worktrees/slots, CLI processes, git + vendor credentials | The machine itself          |

The control plane is AWS (API Gateway, Lambda, DynamoDB, S3). It has no standing app server. Hosts are capacity you bring: a VPS, a spare workstation, whatever can run the daemon and the CLIs. Work can sit in the queue with zero hosts online.

The debug-only **host pane** (`:7422`) is a local UI on one machine. It is not the host plane. Operators run the fleet from the control plane.

Topology and ownership: [docs/architecture/](docs/architecture/README.md). Vocabulary: [docs/terminology.md](docs/terminology.md).

---

## What it does and does not

| Does                                                                          | Does not                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue non-interactive CLI sessions (priority, labels, concurrency, resume)    | Interactive / human-in-the-loop driving — no pairing TTY, no in-browser IDE, no multiplayer session                                                                 |
| Trigger work from the API, GitHub Actions, GitHub App mentions, and schedules | Hold or mint provider tokens, git credentials, or SSH keys — those stay on the host. Do not put secrets in prompts; prompts are stored and visible operationally    |
| Run on a serverless control plane that scales to zero                         | Care which agent harness you use — every session is a catalog Command (fixed argv). Register Codex, Claude Code, Grok, or any other CLI                             |
| Observe live logs, history, and (optional) Slack lifecycle                    | Own the target repo’s GitHub policy, prompt templates, or review workflow — that is the repo harness plus [pr-shepherd](https://github.com/jonathanong/pr-shepherd) |

Sessions target a **named catalog Command**, not a free-form shell string. Operators can register any CLI; callers cannot send arbitrary argv through the API.

Longer contract and non-goals: [docs/why.md](docs/why.md). Trust boundaries: [docs/security.md](docs/security.md).

---

## Why

**Use subscription plans, not APIs.** Most teams already pay for Codex, Claude Code, and the rest. Auto Harness drives those same vendor CLIs natively — non-interactive, no intermediary SDK — so automation burns **seat and plan quota** you already bought instead of opening a pay-per-token bill. Cloud coordination is cheap; the scarce inputs are plan seats and host capacity. Cost model: [docs/costs.md](docs/costs.md).

**It is built for autonomous systems.** A session has no human at the keyboard. Auto Harness will not invent the agent-side loop that unattended work needs:

- **[agent-blackboard](https://github.com/jonathanong/agent-blackboard)** — session-scoped notes the next tick can read, because thinking and progress are not sitting in a TTY
- **[pr-shepherd](https://github.com/jonathanong/pr-shepherd)** — deterministic gather-and-act on CI and review comments, because nobody is watching the PR
- **[no-mistakes](https://github.com/jonathanong/no-mistakes)** — a local AST graph and test selector, so the agent does not grep or guess

Those tools install on the host or in the target repo. Auto Harness queues and runs the CLI; it does not embed them.

---

## Use cases

| Situation                           | What Auto Harness does                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CI goes red**                     | Kick off an agent against the failing repo, aimed at a fix and a PR—not a Slack pile-on                                                                                      |
| **You have a clear change in mind** | Describe the outcome; run it as a tracked session with logs you can audit                                                                                                    |
| **Work was interrupted mid-flight** | Resume the same CLI context on its host while re-establishing the ref in an eligible worktree                                                                                |
| **PRs stall in review**             | Shepherd changes forward—address comments, re-run checks, keep momentum                                                                                                      |
| **The repo needs steady care**      | Schedules for updates, lint, security patches—maintenance without calendar babysitting                                                                                       |
| **CI / bots fire and forget**       | GitHub Actions (or anything) calls the API and exits; humans watch the web UI and/or **GitHub** (PRs, comments)—not the trigger job                                          |
| **The team lives in Slack**         | Connect Slack with OAuth or configure a bot token; lifecycle delivery runs when the configured outbound worker is available—see [docs/integrations.md](docs/integrations.md) |

Anything you can trigger programmatically is fair game. Auto Harness doesn’t care _why_ you started a session—only that you did, with a prompt and a target.

---

## How it feels day to day

1. Something needs doing (a broken build, a written prompt, a schedule firing).
2. A session lands in the queue and runs on your capacity.
3. You watch progress live—or only check the UI when it says it’s done.
4. You review the PR or result like any other change.

Operators use the web UI. Pipelines and bots use the API. Your agents run on machines you control.

---

## Learn more

Everything operational and technical is under **[docs/](docs/README.md)**—setup, API, security, architecture, and the rest. Repo harness hookup examples: **[docs/harness.md](docs/harness.md)**. Why this shape: **[docs/why.md](docs/why.md)**.

**Contributors / agents:** monorepo conventions live in **[AGENTS.md](AGENTS.md)** (`pnpm check` runs the full gate).

Start there when you’re ready to deploy or dig in.

## Harness ecosystem

Auto Harness is the queue and the hosts. Unattended CLIs still need a place to write what they learned, a way to drive a PR without a human, and a deterministic view of the repo:

- [auto-harness](https://github.com/jonathanong/auto-harness) — non-interactive agent CLI queue on hosts you control
- [agent-blackboard](https://github.com/jonathanong/agent-blackboard) — session-scoped telemetry for autonomous agents
- [pr-shepherd](https://github.com/jonathanong/pr-shepherd) — autonomous pull request shepherd
- [no-mistakes](https://github.com/jonathanong/no-mistakes) — deterministic AST-based codebase intelligence, test selection, and linting for agents
