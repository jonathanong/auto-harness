# Repo harness → Auto Harness

How a product repository’s **automation harness** (GitHub Actions, prompts, policy) hooks into **Auto Harness** (queue, worktrees, non-interactive CLIs).

Examples use **filaments** (internal monorepo) naming and flows. Any monorepo can copy the same shape.

API: [api.md](api.md). Slack: [integrations.md](integrations.md). Why / cost model: [why.md](why.md), [costs.md](costs.md).

---

## Requirements

### Auto Harness must provide

| Requirement                                  | Notes                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Fast `POST /sessions` (and `/resume`)        | Repo GHA is **fire and forget** — 201 + `id`, then the job ends                      |
| Service-account auth                         | Actions secret `HARNESS_TOKEN` (`hns_…`)                                             |
| Queue, labels, worktrees, multi-agent assign | Actually runs the CLI after GHA is gone                                              |
| Non-interactive CLI execution                | Subscription path; not Agent SDKs ([why.md](why.md))                                 |
| Slack session lifecycle threads              | Primary harness-side status for unattended runs ([integrations.md](integrations.md)) |
| Terminal statuses including `usage_limit`    | Visible in Slack / API; caller decides retries                                       |
| Session id in Slack (and API)                | Resume, UI deep links                                                                |
| Resume pins same agent + worktree            | Shepherd / multi-tick work                                                           |
| Cancel, timeout, agent drain-on-update       | Ops                                                                                  |

### Repo harness owns (out of scope for Auto Harness)

| Concern                              | Example in filaments                              |
| ------------------------------------ | ------------------------------------------------- |
| Event triggers                       | `workflow_run`, `issue_comment`, cron             |
| Policy before create                 | Transient CI triage, dedup, comment authz         |
| Prompt content                       | `docs/prompts/…`, render actions                  |
| Trusted publish / write-token policy | If any — not the fire-and-forget create path      |
| Usage-limit _retry scheduling_       | Later GHA, human, or poller → new `POST` / resume |
| Host sandbox / CLI hooks             | `.codex/`, bubblewrap, runner disk health         |

### Human observation (not the trigger job)

| Channel    | What humans watch                                |
| ---------- | ------------------------------------------------ |
| **Slack**  | Session thread from Auto Harness                 |
| **GitHub** | PRs, comments, checks from agent work on the VPS |

---

## Two harnesses

| Layer            | Lives in                                                            | Owns                                                                  |
| ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Repo harness** | Product repo (e.g. filaments `.github/workflows`, `docs/prompts/…`) | When to run, who may trigger, prompt text, dedup, triage, GitHub UX   |
| **Auto Harness** | Shared control plane + VPS agents                                   | Queue, worktrees, spawn CLI, logs, Slack session threads, resume pins |

```mermaid
flowchart TB
  subgraph Repo["Repo harness (filaments)"]
    EV[GitHub events]
    GHA[Short GitHub Actions jobs]
    P[Prompt templates / policy]
    EV --> GHA
    P --> GHA
  end

  subgraph AH["Auto Harness"]
    API[REST POST /sessions]
    Q[Queue + scheduler]
    AG[VPS agent + worktrees]
    CLI[Non-interactive Codex / Claude / …]
    API --> Q --> AG --> CLI
  end

  subgraph Humans["Humans listen"]
    SL[Slack session threads]
    GH[GitHub PRs / comments / checks]
  end

  GHA -->|"fire and forget<br/>Bearer hns_…"| API
  AH --> SL
  CLI --> GH
  SL --> Humans
  GH --> Humans
```

**Contract:** repo harness **creates a session and exits**. Auto Harness **runs the work**. Humans watch **Slack and/or GitHub**, not the trigger Actions job.

---

## Shared setup (once per org)

```mermaid
sequenceDiagram
  participant Ops as Operator
  participant AH as Auto Harness
  participant VPS as VPS agent
  participant Fil as filaments secrets

  Ops->>AH: Deploy control plane, Slack integration
  Ops->>AH: Create repository id for filaments
  Ops->>AH: Create service account API key
  Ops->>VPS: Install agent, clone filaments, worktrees, labels e.g. codex
  Ops->>VPS: Login CLIs under subscription profiles
  Ops->>Fil: HARNESS_API_URL, HARNESS_TOKEN, HARNESS_REPO_ID
```

Filaments (or any repo) only needs:

| Secret / var      | Purpose                                         |
| ----------------- | ----------------------------------------------- |
| `HARNESS_API_URL` | e.g. `https://harness.example.com`              |
| `HARNESS_TOKEN`   | Service account `hns_…`                         |
| `HARNESS_REPO_ID` | Control-plane repository id for this git remote |

Agent host maps that same `repositoryId` to a local checkout path in agent config ([setup.md](setup.md), [local-development.md](local-development.md)).

---

## Pattern A — Main CI failed → auto-fix session

**Today in filaments:** `codex-fix-main` (after transient triage).  
**Hookup:** short job decides “needs Codex,” renders fix-main prompt, `POST /sessions`, done.

```mermaid
sequenceDiagram
  participant CI as Main CI workflow
  participant FM as codex-fix-main (GHA)
  participant AH as Auto Harness API
  participant Agent as VPS agent
  participant Slack as Slack
  participant GitHub as GitHub

  CI-->>FM: workflow_run completed failure
  FM->>FM: Transient catalogue? maybe gh run rerun only
  alt Needs agent
    FM->>FM: Dedup / related candidates / render prompt
    FM->>AH: POST /sessions (source webhook, labels codex)
    AH-->>FM: 201 { id: sess-… }
    FM->>FM: Optional: job summary with session id
    Note over FM: Job ends — fire and forget
    AH->>Slack: Thread — session queued
    AH->>Agent: session:assign
    AH->>Slack: Session started
    Agent->>Agent: Non-interactive codex in worktree
    Agent->>GitHub: PR / commits / comments (as allowed)
    AH->>Slack: Completed or failed / usage_limit
  end
```

Illustrative step (after prompt is in `$PROMPT`):

```yaml
# filaments/.github/workflows/codex-fix-main.yml (conceptual)
- name: Dispatch Auto Harness session
  env:
    HARNESS_API_URL: ${{ secrets.HARNESS_API_URL }}
    HARNESS_TOKEN: ${{ secrets.HARNESS_TOKEN }}
    HARNESS_REPO_ID: ${{ secrets.HARNESS_REPO_ID }}
    PROMPT: ${{ steps.render.outputs.prompt }}
  run: |
    curl -fsS -X POST "${HARNESS_API_URL}/api/v1/sessions" \
      -H "Authorization: Bearer ${HARNESS_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n \
        --arg repositoryId "$HARNESS_REPO_ID" \
        --arg prompt "$PROMPT" \
        '{
          repositoryId: $repositoryId,
          prompt: $prompt,
          command: "codex -p",
          timeout: 6300,
          priority: 20,
          requiredLabels: ["codex"],
          source: "webhook"
        }')"
    # no poll — humans watch Slack + GitHub
```

---

## Pattern B — Issue comment `/codex-fix` or `/codex-plan`

**Today:** `codex-fix-issue` / `codex-plan` gate on `issue_comment`.  
**Hookup:** validate author association + command → render prompt → `POST /sessions` → exit.

```mermaid
flowchart LR
  subgraph Filaments
    C["issue_comment<br/>/codex-fix or /codex-plan"]
    G["Gate: OWNER / COLLABORATOR"]
    R["Render automation prompt"]
    C --> G --> R
  end

  R -->|"POST /sessions<br/>fire and forget"| AH[Auto Harness]
  AH --> S[Slack thread]
  AH --> W[Agent worktree]
  W --> H[GitHub issue/PR activity]
  S --> Human[Human]
  H --> Human
```

| Comment       | Typical session intent                                                   |
| ------------- | ------------------------------------------------------------------------ |
| `/codex-fix`  | Implement fix; agent/GitHub surfaces PR or updates                       |
| `/codex-plan` | Plan-only prompt; outcome often issue comment or plan artifact via tools |

Same fire-and-forget API; only the **rendered prompt** (and maybe `priority` / `timeout`) changes.

---

## Pattern C — PR `/pr-shepherd`

**Today:** `codex-pr-shepherd` with long runner session + resume.  
**Hookup:** short gate job → `POST /sessions` (first tick) or `POST /sessions/:id/resume` (continue same worktree) → exit. Humans follow Slack + the PR on GitHub.

```mermaid
sequenceDiagram
  participant Dev as Collaborator
  participant GHA as codex-pr-shepherd GHA
  participant AH as Auto Harness
  participant Agent as Agent worktree
  participant PR as GitHub PR
  participant Slack as Slack

  Dev->>PR: Comment /pr-shepherd
  GHA->>GHA: Gate + resolve PR head
  alt First dispatch
    GHA->>AH: POST /sessions (shepherd prompt, labels codex)
  else Continue same work
    GHA->>AH: POST /sessions/{id}/resume
  end
  Note over GHA: Fire and forget
  AH->>Slack: Session lifecycle
  AH->>Agent: assign / resume pin same worktree
  Agent->>PR: Push / comment / react to checks
  Dev->>Slack: Status
  Dev->>PR: Review PR updates
```

Resume is how the **repo harness** re-enters without losing the workspace: pass the prior **session id** (from Slack, job summary, or a comment your gate stored).

```bash
# Continue shepherd on same agent + worktree
curl -fsS -X POST "${HARNESS_API_URL}/api/v1/sessions/${SESSION_ID}/resume" \
  -H "Authorization: Bearer ${HARNESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Continue pr-shepherd from current PR state."}'
```

---

## Pattern D — Dependabot CI red

**Today:** `codex-fix-dependabot`.  
**Hookup:** on failed Dependabot PR workflow → render dependabot prompt → `POST /sessions` → humans watch Slack + the Dependabot PR on GitHub.

```mermaid
flowchart TB
  DB[Dependabot PR CI failure] --> GHA[Short GHA: dedupe + render]
  GHA -->|POST /sessions| AH[Auto Harness]
  AH --> Agent[codex label worktree]
  Agent --> PR[Update / refresh Dependabot PR on GitHub]
  AH --> Slack[Slack thread]
  PR --> Human[Human]
  Slack --> Human
```

---

## Pattern E — Scheduled maintenance prompts

**Today:** `codex-scheduled-prompts` rotates `docs/prompts/scheduled/*.md`.  
**Hookup:** cron workflow selects + renders one prompt file → `POST /sessions` → done. Catalog stays **in filaments**; Auto Harness only receives the final string.

```mermaid
flowchart TB
  CRON[schedule: cron] --> SEL[select-prompt job]
  SEL --> FILES["docs/prompts/scheduled/*.md"]
  FILES --> REN[Render via automation wrapper]
  REN -->|POST /sessions| AH[Auto Harness]
  AH --> Agent[Agent on filaments checkout]
  Agent --> GH[GitHub: PR or issue hygiene]
  AH --> Slack[Slack]
```

Optional alternative: Auto Harness [schedules](api.md) with a fixed command that only runs a **repo-local** script (`node ci/run-scheduled-prompt.mts`)—selection logic still owned by filaments files on disk.

---

## Pattern F — Usage limit then try again later

Agent hits plan quota → session `failed` + `errorCode: usage_limit` → **Slack** shows it.  
Retry is **outside** Auto Harness: human, later GHA, or filaments poller creates a **new** session or **resume**.

```mermaid
sequenceDiagram
  participant Agent
  participant AH as Auto Harness
  participant Slack
  participant Later as Later GHA / human

  Agent->>AH: usage_limit detected
  AH->>Slack: Failed — usage limit
  Note over Later: Hours later, quota recovered
  Later->>AH: POST /sessions or /resume
  Note over Later: Fire and forget again
```

---

## End-to-end map (filaments workflows → AH)

```mermaid
flowchart LR
  subgraph Triggers["Filaments GHA entrypoints"]
    FM[codex-fix-main]
    FI[codex-fix-issue]
    PL[codex-plan]
    SH[codex-pr-shepherd]
    DP[codex-fix-dependabot]
    SC[codex-scheduled-prompts]
  end

  subgraph Call["Single integration"]
    POST["POST /sessions<br/>or /resume"]
  end

  subgraph AH["Auto Harness"]
    RUN[Queue · worktrees · CLI]
  end

  subgraph Observe["Human observation"]
    SL[Slack]
    GH[GitHub]
  end

  FM --> POST
  FI --> POST
  PL --> POST
  SH --> POST
  DP --> POST
  SC --> POST
  POST --> RUN
  RUN --> SL
  RUN --> GH
```

What **leaves** the long-running Actions runner: Codex process, multi-hour job, log babysitting in GHA.  
What **stays** in filaments: event filters, triage, dedup, prompt files, comment gates—anything that finishes in minutes before the `curl`.

---

## Checklist for another repo

1. Register repo + service account in Auto Harness; put secrets in that repo’s Actions.
2. Run an agent with worktrees/labels matching `requiredLabels`.
3. For each automation entrypoint: **prepare prompt → `POST /sessions` → exit**.
4. Configure Slack; tell humans to watch **Slack + GitHub**, not the trigger workflow.
5. Use **resume** when the same worktree context must continue.

API details: [api.md](api.md). Why CLI/subscriptions: [why.md](why.md).
