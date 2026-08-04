# Playwright E2E tests

Browser end-to-end tests for the **control-plane UI** (`:7421`) and **host-pane UI** (`:7422`). Unit/integration coverage remains under Vitest (`pnpm test`).

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

**Production UI builds only** — not `next dev`. `pnpm test:e2e` runs `pnpm build:web` first (cleans each app’s `.next`, then `next build` for control + agent-web), then Playwright starts production servers via `next start`.

`playwright.config.ts` uses **`webServer`** (array) so Playwright boots and waits for:

| Name          | Command                                                              | Ready URL                      |
| ------------- | -------------------------------------------------------------------- | ------------------------------ |
| `api`         | `pnpm local:dynamodb && pnpm local:dynamodb:ready && pnpm local:api` | `http://127.0.0.1:7420/health` |
| `control-web` | `pnpm local:web:start` (`next start` on `:7421`)                     | `http://127.0.0.1:7421`        |
| `agent-web`   | `pnpm local:agent-web:start` (`next start` on `:7422`)               | `http://127.0.0.1:7422`        |

Locally, `reuseExistingServer: !process.env.CI` reuses servers if already running. In CI, servers are always started fresh.

**Note:** The agent **daemon** (`pnpm local:agent start`) is **not** started by Playwright (optional for most UI tests). Tests that need profiles seed host config + `agent:register` via REST.

---

## Run commands

```bash
# Build both UIs (production) then run all Playwright tests (parallel)
pnpm test:e2e

# Build + UI mode
pnpm test:e2e:ui

# Rebuild only
pnpm build:web

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
- **No shared mutable fixtures.** Mutations use unique ids:

```ts
const id = `pw-repo-${test.info().parallelIndex}-${Date.now()}`;
```

- Prefer seeding via `request` (Playwright APIRequestContext → API :7420) over serial UI setup when possible.

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

| Pattern            | Meaning               |
| ------------------ | --------------------- |
| `page-*`           | Page root container   |
| `nav-*`            | Primary nav link      |
| `form-*`           | Form root             |
| `*-submit`         | Primary submit button |
| `*-error` / `*-ok` | Form feedback         |
| `stat-*`           | Dashboard metric      |

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
| `page-session-detail`, `session-detail`, `session-detail-id`, `session-detail-status`, `session-detail-back`, `page-session-detail-not-found`                                                                     | Session detail (`/sessions/[id]`)                                      |
| `session-cancel`, `session-resume`, `session-archive`, `session-action-error`, `session-logs`, `session-logs-empty`                                                                                               | Session actions + logs                                                 |
| `page-repositories`, `repositories-heading`, `add-repo-open`, `repo-link-*`                                                                                                                                       | Repositories                                                           |
| `add-repo-dialog`, `dialog-close`, `form-repo-catalog`, `repo-catalog-name`, `repo-catalog-url`, `repo-catalog-branch`, `repo-catalog-submit`, `repo-catalog-error`                                               | Add repository modal (catalog; the only way to create a catalog entry) |
| `form-attach-local-repo`, `attach-repo-agent-id`, `attach-repo-catalog-id`, `attach-repo-path`, `attach-repo-branch`, `attach-repo-submit`, `attach-repo-ok`, `attach-repo-error`                                 | Attach an existing catalog repo to a host                              |
| `page-repository-detail`, `repository-detail`, `repository-detail-id`, `repository-detail-path`, `repository-detail-back`, `page-repository-detail-not-found`                                                     | Repository detail (`/repositories/[id]`)                               |
| `page-worktrees`, `worktrees-heading`, `worktree-group-*`, `worktree-row-*`, `worktree-link-*`                                                                                                                    | Worktrees (fleet, hierarchical)                                        |
| `page-worktree-detail`, `worktree-detail`, `worktree-detail-id`, `worktree-detail-path`, `worktree-detail-back`, `page-worktree-detail-not-found`                                                                 | Worktree detail (`/worktrees/[id]`)                                    |
| `page-schedules`, `schedules-heading`                                                                                                                                                                             | Schedules                                                              |
| `form-create-schedule`, `schedule-repository-id`, `schedule-name`, `schedule-command-profile`, `schedule-cron`, `schedule-submit`, `schedule-error`                                                               | Schedule form                                                          |
| `page-hosts`, `hosts-heading`, `host-filters`, `host-filter-online`, `form-add-host`, `add-host-id`, `add-host-submit`, `add-host-ok`, `add-host-error`, `host-row-*`, `host-drain-*`                             | Hosts                                                                  |

### Host pane (`services/agent-web`)

| `data-pw`                                                                                                                                                               | Where                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `host-shell`                                                                                                                                                            | App shell                                 |
| `nav-status`, `nav-repositories`, `nav-worktrees`, `nav-sessions`                                                                                                       | Nav                                       |
| `page-host-status`, `host-status-id`, `host-drain`                                                                                                                      | Status                                    |
| `stat-host-config-link`, `stat-worktrees-link`, `stat-worktrees`, `stat-sessions-link`, `stat-sessions-sample`                                                          | Status stat cards (link to pages)         |
| `page-repositories`, `repositories-heading`, `add-repo-open`                                                                                                            | Repositories                              |
| `add-repo-dialog`, `dialog-close`, `form-add-local-repo`, `add-repo-catalog-id`, `add-repo-path`, `add-repo-branch`, `add-repo-submit`, `add-repo-ok`, `add-repo-error` | Add repository modal (attach, no create)  |
| `repo-row-*`, `repo-link-*`, `worktree-group-*`, `worktree-row-*`, `worktree-link-*`                                                                                    | Repositories table + nested worktrees     |
| `page-repository-detail`, `repository-detail`, `repository-detail-id`, `repository-detail-path`, `repo-remove-*`, `page-repository-detail-not-found`                    | Repository detail (`/repositories/[id]`)  |
| `page-worktrees`, `worktrees-heading`, `add-worktree-open-*`, `form-add-worktree-*`, `worktree-remove-*`                                                                | Worktrees (hierarchical, editable)        |
| `page-worktree-detail`, `worktree-detail`, `worktree-detail-id`, `worktree-detail-path`, `worktree-detail-back`, `page-worktree-detail-not-found`                       | Worktree detail (`/worktrees/[id]`)       |
| `page-sessions`, `sessions-heading`, `session-filters`, `session-filter-status`, `session-filter-q`, `session-link-*`                                                   | Sessions list                             |
| `page-session-detail`, `session-detail`, `session-detail-id`, `session-detail-status`, `session-cancel`, `session-resume`, `session-archive`, `session-logs`            | Session detail (`/sessions/[id]`)         |
| `form-host-config-json`, `host-config-json`, `host-config-submit`, `host-config-ok`, `host-config-error`                                                                | Raw JSON inventory (on Repositories page) |

---

## Test inventory

### Project `control` — baseURL `http://127.0.0.1:7421`

| File                               | Tests                                                          | What it covers                                            |
| ---------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| `e2e/control/dashboard.spec.ts`    | loads shell and dashboard stats                                | Shell, heading, stat cards                                |
|                                    | nav links are present                                          | All primary nav `data-pw` links                           |
| `e2e/control/sessions.spec.ts`     | sessions list page and filters                                 | List page; status filter updates URL                      |
|                                    | new session form is present                                    | Form fields visible                                       |
|                                    | create session via API-backed form when profiles exist         | Submits form; lands on detail page; cancel unlocks resume |
|                                    | unknown session id shows a not-found state                     | `/sessions/[id]` 404-style state                          |
| `e2e/control/repositories.spec.ts` | repositories page loads with add-repository dialog closed      | Page + closed modal + nested worktrees section            |
|                                    | create catalog repository via modal, then open its detail page | Opens modal; parallel-safe catalog create; click-through  |
|                                    | unknown repository id shows a not-found state                  | `/repositories/[id]` 404-style state                      |
| `e2e/control/worktrees.spec.ts`    | worktrees page loads                                           | Page + heading                                            |
|                                    | unknown worktree id shows a not-found state                    | `/worktrees/[id]` 404-style state                         |
|                                    | clicking a worktree opens its fleet-wide detail page           | Seeds host config via API; click-through to detail page   |
| `e2e/control/schedules.spec.ts`    | schedules page and create form                                 | Seeds repo via API; creates schedule in UI                |
| `e2e/control/hosts.spec.ts`        | hosts page loads with filters and add form                     | Page + add host form + online filter URL                  |
|                                    | add host creates empty host inventory slot                     | Parallel-safe empty host config                           |

### Project `agent` — baseURL `http://127.0.0.1:7422`

| File                             | Tests                                                                | What it covers                                             |
| -------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `e2e/agent/status.spec.ts`       | loads agent shell and status page                                    | Shell, agent id `local-1`, drain control                   |
|                                  | stat cards link to their pages                                       | Host config/worktrees/sessions cards are links             |
| `e2e/agent/repositories.spec.ts` | repositories page loads with add-repository dialog closed            | Page + closed modal                                        |
|                                  | add repository via modal, nested worktrees section shows it empty    | Modal add flow; nested hierarchical worktrees              |
|                                  | clicking a repository opens its detail page; removing redirects back | Modal add flow; click-through, remove, redirect            |
|                                  | unknown repository id shows a not-found state                        | `/repositories/[id]` 404-style state                       |
| `e2e/agent/worktrees.spec.ts`    | worktrees page loads                                                 | Page + heading                                             |
|                                  | clicking a worktree opens its detail page; removing redirects back   | Seeds host config via API; click-through, remove, redirect |
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
3. `pnpm test:e2e` — `build:web` (production `next build`), then Playwright `webServer` starts DynamoDB Local (Docker), API, and both UIs via **`next start`**
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
