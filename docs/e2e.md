# Playwright E2E tests

Browser end-to-end tests for the **control-plane UI** (`:7431`) and **host-pane UI** (`:7432`) — a
dedicated port range (and dedicated DynamoDB container), separate from the normal `:7421`/`:7422`
dev ports; see [How the stack is started](#how-the-stack-is-started). Unit/integration coverage
remains under Vitest (`pnpm test`).

Related: [local-development.md](local-development.md), [agent-e2e-testing.md](agent-e2e-testing.md).

---

## Prerequisites

- Node ≥ 22.18, pnpm, Docker (DynamoDB Local)
- One-time browser install:

```bash
pnpm install
pnpm exec playwright install chromium
```

---

## How the stack is started

**Production UI builds only** — not `next dev`. `pnpm test:e2e` runs `pnpm build:web:e2e` first (cleans each app's `.next-e2e`, then `next build` for control + agent-web), then Playwright starts production servers via `next start`.

**Why a separate build, not just separate ports:** `HARNESS_API_HTTP=http://127.0.0.1:7430` has to
be set for e2e at **two different times**, for two different code paths, and missing either one
silently sends requests to the dev API on `:7420` instead:

- **Build time** — the browser's same-origin API calls go through `rewrites()` in each app's
  `next.config.ts`, which Next.js bakes into `routes-manifest.json` at `next build` time;
  `next start` just serves that frozen file, it does not re-read env vars at runtime. This is why
  e2e needs its own `next build` (`build:e2e` in each app's `package.json`), not just a
  differently-configured `next start` of the normal dev build.
- **Run time** — server components (RSC) fetch the control plane directly via `apiBase()` /
  `resolveServerApiBase()` (`modules/shared/src/api-client.ts`), which reads
  `process.env.HARNESS_API_HTTP` **fresh on every request** inside the running `next start`
  process, falling back to `LOCAL_API_HTTP` (`:7420`) if unset. This is why `start:e2e` in each
  app's `package.json` also sets `HARNESS_API_HTTP=http://127.0.0.1:7430` — dropping it doesn't
  break the build, it breaks every server-rendered page at runtime with a generic "fetch failed"
  once whatever's on `:7420` doesn't answer.

`HARNESS_E2E=1` (also set by both `build:e2e`/`start:e2e`) points that build's `distDir` at
`.next-e2e` (see `next.config.ts` in each app) so it lands next to, not on top of, a normal dev
`.next` build — the two can coexist on disk.

**Side effect to know about:** `next build` regenerates each app's `next-env.d.ts` to reference
whichever `distDir` it just built (`.next` or `.next-e2e`) — so running `build:web:e2e` locally
will locally modify `next-env.d.ts` to point at `.next-e2e`, and running `build:web`/`next dev`
afterward flips it back to `.next`. This is expected, harmless, and matches whichever build ran
last — don't hand-edit it or worry about it in `git status`; just don't commit it mid-flip. Each
app's `tsconfig.json` lists both `.next/types/**/*.ts` and `.next-e2e/types/**/*.ts` in `include`
so neither build needs to rewrite `tsconfig.json` itself.

`playwright.config.ts` uses **`webServer`** (array) so Playwright boots and waits for:

| Name          | Command                                                                          | Ready URL                      |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| `api`         | `pnpm local:dynamodb:e2e && pnpm local:dynamodb:e2e:ready && pnpm local:api:e2e` | `http://127.0.0.1:7430/health` |
| `control-web` | `pnpm local:web:start:e2e` (`next start` on `:7431`)                             | `http://127.0.0.1:7431`        |
| `agent-web`   | `pnpm local:agent-web:start:e2e` (`next start` on `:7432`)                       | `http://127.0.0.1:7432`        |

Every one of these is on the `743x` range — `+10` from the normal `local:*` dev ports (`742x`)
and dev DynamoDB (`:7423`) — with its own `dynamodb-e2e` container (`:7433`), entirely separate
from anything a manual `pnpm local:*` dev session has running. `reuseExistingServer: false`
unconditionally, both locally and in CI: every `playwright test` invocation force-recreates the
e2e DynamoDB container (wiping all prior test data — `docker compose up -d --force-recreate`) and
restarts the app servers fresh, rather than silently reusing whatever was left running from an
earlier run or a stale build. This is deliberate, not just a CI/local parity nicety — a genuinely
stale leftover process (mismatched `.next` build vs. a since-rebuilt one) has caused real,
confusing failures here before.

**Note:** The agent **daemon** (`pnpm local:agent start`) is **not** started by Playwright as a
`webServer`. Most tests that need profiles seed host config + `agent:register` via REST, against
the e2e API (`:7430`), rather than running a real daemon. The one exception is
`e2e/control/orchestration.spec.ts`, which starts a real daemon in-process (imports
`startAgentDaemon` directly) to prove the full real path works, not just the UI/REST-substituted
half — see [Test inventory](#test-inventory) and
[agent-e2e-testing.md](agent-e2e-testing.md).

---

## Run commands

```bash
# Build both UIs (production) then run all Playwright tests (parallel)
pnpm test:e2e

# Build + UI mode
pnpm test:e2e:ui

# Rebuild only
pnpm build:web:e2e

# After a build: Playwright only (webServer starts next start)
pnpm exec playwright test

# One project
pnpm exec playwright test --project=control
pnpm exec playwright test --project=agent

# One file
pnpm exec playwright test e2e/control/dashboard.spec.ts
```

---

## Parallelism

- Config: `fullyParallel: true` — every **test** can run in parallel across workers.
- Projects `control` and `agent` use different `baseURL`s; tests under `e2e/control/` and `e2e/agent/` match separately.
- **No shared mutable fixtures — except `local-1`.** Every other mutation uses unique ids and
  needs no coordination:

```ts
const id = `pw-repo-${test.info().parallelIndex}-${Date.now()}`;
```

- Prefer seeding via `request` (Playwright APIRequestContext → e2e API :7430) over serial UI setup when possible.

**The one real exception:** the host-pane app is bound to a single agent (`local-1`, no way to
target a different one from its UI), and a few control-plane specs reuse that same agent rather
than register a second live one. Its host config is one full document with no partial-update
API, so any test that reads or mutates it must wrap its whole body (setup → assertions →
teardown) in `withLocalHostLock` from [`e2e/local-1-host.ts`](../e2e/local-1-host.ts) — a
cross-process lockfile, since Playwright workers are separate OS processes. A one-shot
read-verify-retry isn't enough here: a slower concurrent test can still land a stale-snapshot
write _after_ your own write already verified fine. See that file's own comment for the full
reasoning, and `putHostRepo`/`removeHostRepo`/`attachRepoViaUi` for the safe-to-reuse helpers.
Everything else should keep using its own uniquely-named entity with no lock at all.

Do **not** use `test.describe.configure({ mode: "serial" })` unless a file truly cannot parallelize.

---

## Selectors: `data-pw`

Playwright is configured with:

```ts
use: {
  testIdAttribute: "data-pw";
}
```

Use **`page.getByTestId("…")`**, which targets `data-pw="…"` in the DOM.

### Conventions

| Pattern                                          | Meaning                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `page-*`                                         | Page root container                                                                                       |
| `nav-*`                                          | Primary nav link                                                                                          |
| `form-*`                                         | Form root                                                                                                 |
| `*-submit`                                       | Primary submit button                                                                                     |
| `*-error` / `*-ok`                               | Form feedback                                                                                             |
| `stat-*`                                         | Dashboard metric                                                                                          |
| `breadcrumbs`, `breadcrumb-0`, `breadcrumb-1`, … | Breadcrumb trail (shared `DetailHeader`) — index 0 is the root                                            |
| `*-confirm`, `*-confirm-submit`                  | A `ConfirmButton`'s modal and its destructive submit button — the trigger itself keeps the base `data-pw` |

### Control plane (`services/web`)

| `data-pw`                                                                                                                                                                                                         | Where                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `control-shell`                                                                                                                                                                                                   | App shell                                                              |
| `app-header`, `app-nav`, `app-main`, `app-title`                                                                                                                                                                  | Shell chrome                                                           |
| `nav-dashboard`, `nav-session-new`, `nav-sessions`, `nav-repositories`, `nav-schedules`, `nav-hosts`                                                                                                              | Nav                                                                    |
| `page-dashboard`, `dashboard-heading`, `dashboard-new-session`, `dashboard-stats`                                                                                                                                 | Dashboard                                                              |
| `stat-running`, `stat-running-value`, `stat-queued`, `stat-queued-value`, `stat-hosts-online`, `stat-hosts-online-value`                                                                                          | Dashboard stats                                                        |
| `page-sessions`, `sessions-heading`, `session-filters`, `session-filter-status`, `session-filter-q`, `session-link-*`                                                                                             | Sessions list                                                          |
| `page-session-new`, `session-new-heading`                                                                                                                                                                         | New session                                                            |
| `form-create-session`, `create-session-repository-id`, `create-session-command-profile`, `create-session-prompt`, `create-session-timeout`, `create-session-ref`, `create-session-submit`, `create-session-error` | Create session form                                                    |
| `page-session-detail`, `session-detail`, `session-detail-id`, `session-detail-status`, `breadcrumbs`, `page-session-detail-not-found`                                                                             | Session detail (`/sessions/[id]`)                                      |
| `session-cancel`, `session-resume`, `session-archive`, `session-action-error`, `session-logs`, `session-logs-empty`                                                                                               | Session actions + logs                                                 |
| `page-repositories`, `repositories-heading`, `add-repo-open`, `worktrees-hierarchy`, `worktree-group-*`, `repo-link-*`, `worktree-row-*`, `worktree-link-*`                                                       | Repositories: repo → worktrees hierarchy (single merged section)       |
| `add-repo-dialog`, `dialog-close`, `form-repo-catalog`, `repo-catalog-name`, `repo-catalog-url`, `repo-catalog-branch`, `repo-catalog-submit`, `repo-catalog-ok`, `repo-catalog-error`                            | Add repository modal (catalog; the only way to create a catalog entry) |
| `form-attach-local-repo`, `attach-repo-agent-id`, `attach-repo-catalog-id`, `attach-repo-path`, `attach-repo-branch`, `attach-repo-submit`, `attach-repo-ok`, `attach-repo-error`                                 | Attach an existing catalog repo to a host                              |
| `page-repository-detail`, `repository-detail`, `repository-detail-id`, `breadcrumbs`, `page-repository-detail-not-found`                                                                                          | Repository detail (`/repositories/[id]`)                               |
| `repository-detail-tabs`, `tab-sessions`, `tab-worktrees`, `tab-settings`, `repository-detail-path`                                                                                                               | Repository detail tabs (Sessions default, Worktrees, Settings)         |
| `page-worktrees`, `worktrees-heading`, `worktree-group-*`, `worktree-row-*`, `worktree-link-*`                                                                                                                    | Worktrees (fleet, hierarchical)                                        |
| `page-worktree-detail`, `worktree-detail`, `worktree-detail-id`, `breadcrumbs`, `page-worktree-detail-not-found`                                                                                                  | Worktree detail (`/worktrees/[id]`)                                    |
| `worktree-detail-tabs`, `tab-sessions`, `tab-settings`, `worktree-detail-path`                                                                                                                                    | Worktree detail tabs (Sessions default, Settings)                      |
| `page-schedules`, `schedules-heading`                                                                                                                                                                             | Schedules                                                              |
| `form-create-schedule`, `schedule-repository-id`, `schedule-name`, `schedule-command-profile`, `schedule-cron`, `schedule-submit`, `schedule-error`                                                               | Schedule form                                                          |
| `page-hosts`, `hosts-heading`, `host-filters`, `host-filter-online`, `form-add-host`, `add-host-id`, `add-host-submit`, `add-host-ok`, `add-host-error`, `host-row-*`, `host-drain-*`                             | Hosts                                                                  |

### Host pane (`services/agent-web`)

| `data-pw`                                                                                                                                                                                               | Where                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `host-shell`                                                                                                                                                                                            | App shell                                                          |
| `nav-status`, `nav-repositories`, `nav-sessions`                                                                                                                                                        | Nav                                                                |
| `page-host-status`, `host-status-id`, `host-drain`                                                                                                                                                      | Status                                                             |
| `stat-host-config-link`, `stat-worktrees-link`, `stat-worktrees`, `stat-sessions-link`, `stat-sessions-sample`                                                                                          | Status stat cards (link to pages)                                  |
| `page-repositories`, `repositories-heading`, `add-repo-open`                                                                                                                                            | Repositories                                                       |
| `add-repo-dialog`, `dialog-close`, `form-add-local-repo`, `add-repo-catalog-id`, `add-repo-path`, `add-repo-branch`, `add-repo-submit`, `add-repo-ok`, `add-repo-error`                                 | Add repository modal (attach, no create)                           |
| `worktrees-hierarchy`, `worktree-group-*`, `repo-link-*`, `worktree-row-*`, `worktree-link-*`                                                                                                           | Repositories: repo → worktrees hierarchy (single merged section)   |
| `page-repository-detail`, `repository-detail`, `repository-detail-id`, `breadcrumbs`, `repo-remove-*` (+ `-confirm`/`-confirm-submit`), `page-repository-detail-not-found`                              | Repository detail (`/repositories/[id]`)                           |
| `repository-detail-tabs`, `tab-sessions`, `tab-worktrees`, `tab-settings`, `repository-detail-path`, `add-worktree-open-*`, `form-add-worktree-*`, `worktree-remove-*` (+ `-confirm`/`-confirm-submit`) | Repository detail tabs (add/remove worktrees on the Worktrees tab) |
| `page-worktree-detail`, `worktree-detail`, `worktree-detail-id`, `breadcrumbs`, `page-worktree-detail-not-found`                                                                                        | Worktree detail (`/worktrees/[id]`)                                |
| `worktree-detail-tabs`, `tab-sessions`, `tab-settings`, `worktree-detail-path`                                                                                                                          | Worktree detail tabs                                               |
| `page-sessions`, `sessions-heading`, `session-filters`, `session-filter-status`, `session-filter-q`, `session-link-*`                                                                                   | Sessions list                                                      |
| `page-session-detail`, `session-detail`, `session-detail-id`, `session-detail-status`, `session-cancel`, `session-resume`, `session-archive`, `session-logs`                                            | Session detail (`/sessions/[id]`)                                  |
| `form-host-config-json`, `host-config-json`, `host-config-submit`, `host-config-ok`, `host-config-error`                                                                                                | Raw JSON inventory (on Repositories page)                          |

---

## Test inventory

### Project `control` — baseURL `http://127.0.0.1:7431`

| File                                | Tests                                                          | What it covers                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/control/dashboard.spec.ts`     | loads shell and dashboard stats                                | Shell, heading, stat cards                                                                                                                  |
|                                     | nav links are present                                          | All primary nav `data-pw` links                                                                                                             |
| `e2e/control/sessions.spec.ts`      | sessions list page and filters                                 | List page; status filter updates URL                                                                                                        |
|                                     | new session form is present                                    | Form fields visible                                                                                                                         |
|                                     | create session via API-backed form when profiles exist         | Submits form; lands on detail page; cancel unlocks resume                                                                                   |
|                                     | unknown session id shows a not-found state                     | `/sessions/[id]` 404-style state                                                                                                            |
| `e2e/control/repositories.spec.ts`  | repositories page loads with add-repository dialog closed      | Page + closed modal + nested worktrees section                                                                                              |
|                                     | create catalog repository via modal, then open its detail page | Opens modal; parallel-safe catalog create; click-through                                                                                    |
|                                     | unknown repository id shows a not-found state                  | `/repositories/[id]` 404-style state                                                                                                        |
| `e2e/control/worktrees.spec.ts`     | worktrees page loads                                           | Page + heading                                                                                                                              |
|                                     | unknown worktree id shows a not-found state                    | `/worktrees/[id]` 404-style state                                                                                                           |
|                                     | clicking a worktree opens its fleet-wide detail page           | Seeds host config via API; click-through to detail page                                                                                     |
| `e2e/control/schedules.spec.ts`     | schedules page and create form                                 | Seeds repo via API; creates schedule in UI                                                                                                  |
| `e2e/control/hosts.spec.ts`         | hosts page loads with filters and add form                     | Page + add host form + online filter URL                                                                                                    |
|                                     | add host creates empty host inventory slot                     | Parallel-safe empty host config                                                                                                             |
| `e2e/control/orchestration.spec.ts` | browser-created session runs on a real agent and completes     | Real agent daemon (real WS, real subprocess) — the only spec here that doesn't fake the agent side over REST; see docs/agent-e2e-testing.md |

### Project `agent` — baseURL `http://127.0.0.1:7432`

| File                             | Tests                                                                | What it covers                                             |
| -------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `e2e/agent/status.spec.ts`       | loads host shell and status page                                     | Shell, agent id `local-1`, drain control                   |
|                                  | stat cards link to their pages                                       | Host config/worktrees/sessions cards are links             |
| `e2e/agent/repositories.spec.ts` | repositories page loads with add-repository dialog closed            | Page + closed modal                                        |
|                                  | attach repository via modal, nested worktrees section shows it empty | Modal attach flow; nested hierarchical worktrees           |
|                                  | clicking a repository opens its detail page; removing redirects back | Modal add flow; click-through, remove, redirect            |
|                                  | unknown repository id shows a not-found state                        | `/repositories/[id]` 404-style state                       |
| `e2e/agent/worktrees.spec.ts`    | clicking a worktree opens its detail page; removing redirects back   | Seeds host config via API; click-through, remove, redirect |
| `e2e/agent/sessions.spec.ts`     | sessions page loads                                                  | Page + heading                                             |
|                                  | clicking a session opens its detail page                             | Seeds + assigns a session via API; click-through           |

---

## Config reference

- Config file: [`playwright.config.ts`](../playwright.config.ts)
- Test dir: `e2e/`
- Reporter: `list` locally; `github` + `list` when `CI` is set
- Trace: `on-first-retry`; screenshot: `only-on-failure`

---

## CI notes

GitHub Actions (`.github/workflows/ci.yml`) runs a parallel job **`playwright (control + agent)`**:

1. `pnpm install --frozen-lockfile`
2. Install Chromium (`playwright install --with-deps`, browsers cached on `pnpm-lock.yaml`)
3. `pnpm test:e2e` — `build:web:e2e` (production `next build` into `.next-e2e`), then Playwright `webServer` starts DynamoDB Local (Docker), API, and both UIs via **`next start`**
4. On failure, uploads `playwright-report/` and `test-results/` as artifacts (7-day retention)

GitHub sets `CI=true`, so config applies:

- `reuseExistingServer: false`
- `retries: 2`, `workers: 2`
- reporters: `github` + `list`

Local install for CI-like runs:

```bash
pnpm exec playwright install --with-deps chromium
CI=1 pnpm test:e2e
```

---

## Adding a test

1. Prefer a new `test()` under the right project folder (`e2e/control` or `e2e/agent`).
2. Use only `getByTestId(...)` / `data-pw` (add attributes in UI if missing).
3. Keep the test self-contained and parallel-safe (unique resource ids).
4. Document it in the **Test inventory** tables above.
