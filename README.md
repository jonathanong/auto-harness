# Auto Harness

**Your software factory, on autopilot.**

Auto Harness turns the AI coding tools you already use—Codex, Claude Code, and the rest—into a reliable part of how your team ships software. Trigger work from CI, chat, or a simple prompt; watch it run; get a pull request instead of a ticket queue.

You keep control of secrets and machines. Auto Harness coordinates the work.

---

## Why

Engineering orgs drown in the same loops: red builds, nitpick reviews, dependency churn, “someone should fix that.” Humans should set direction—not babysit every failed check or routine update.

Most teams already pay for **coding-agent subscriptions**. Those plans generally **do not include Agent SDKs**, so factory automation has to drive the same tools through **non-interactive CLI** mode—queued, logged, and concurrent—on machines you control. That is what Auto Harness is for: **subscription capacity → unattended software work**, not a new pay-per-token API bill.

Auto Harness is for teams that want:

- **Faster recovery when things break** — CI fails → a fix session starts without waiting for a free engineer
- **Less toil, same standards** — repetitive maintenance and prompt-driven changes run the same way every time
- **Visibility without babysitting** — live sessions, history, and notifications so you know what the agents did
- **Scale that matches headcount** — more concurrent work when you need it, queued and prioritized when you don’t

The win is **time and throughput**. Cloud coordination is cheap; the scarce inputs are **plan seats/quota** and **host capacity**. More on rationale and cost: [docs/why.md](docs/why.md), [docs/costs.md](docs/costs.md).

---

## Use cases

| Situation | What Auto Harness does |
|-----------|-------------------------|
| **CI goes red** | Kick off an agent against the failing repo, aimed at a fix and a PR—not a Slack pile-on |
| **You have a clear change in mind** | Describe the outcome; run it as a tracked session with logs you can audit |
| **Work was interrupted mid-flight** | Resume the same session context on the same agent and worktree |
| **PRs stall in review** | Shepherd changes forward—address comments, re-run checks, keep momentum |
| **The repo needs steady care** | Schedules for updates, lint, security patches—maintenance without calendar babysitting |
| **CI / bots fire and forget** | GitHub Actions (or anything) calls the API and exits; humans watch **Slack** and/or **GitHub** (PRs, comments)—not the trigger job |
| **The team lives in Slack** | One thread per session for harness status alongside GitHub activity |

Anything you can trigger programmatically is fair game. Auto Harness doesn’t care *why* you started a session—only that you did, with a prompt and a target.

---

## How it feels day to day

1. Something needs doing (a broken build, a written prompt, a schedule firing).
2. A session lands in the queue and runs on your capacity.
3. You watch progress live—or only look when Slack or the UI says it’s done.
4. You review the PR or result like any other change.

Operators use the web UI. Pipelines and bots use the API. Your agents run on machines you control.

---

## What you get out of it

- **Shorter time-to-green** after failures  
- **Fewer context switches** for “quick fixes” that aren’t  
- **A single place** to see automated coding work—not a scatter of laptop terminals  
- **Room to grow** from one repo and one engineer to many agents and many repos  

---

## Trust boundaries (in plain terms)

- Auto Harness **does not** hold your git credentials or AI API keys—those stay on **your** runners  
- **Don’t put secrets in prompts**—prompts are stored and visible operationally  
- You decide which tools run and how hard they work  

Details live in the docs, not here.

---

## Learn more

Everything operational and technical is under **[docs/](docs/README.md)**—setup, API, security, architecture, and the rest. Repo hookup examples (filaments-style): **[docs/harness.md](docs/harness.md)**.

Start there when you’re ready to deploy or dig in.
