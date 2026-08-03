# Playwright E2E tests

Browser end-to-end tests for the **control-plane UI** (`:7421`) and **agent-pane UI** (`:7423`). Unit/integration coverage remains under Vitest (`pnpm test`).

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

`playwright.config.ts` uses **`webServer`** (array) so Playwright boots and waits for:

| Name          | Command                                                              | Ready URL                      |
| ------------- | -------------------------------------------------------------------- | ------------------------------ |
| `api`         | `pnpm local:dynamodb && pnpm local:dynamodb:ready && pnpm local:api` | `http://127.0.0.1:7420/health` |
| `control-web` | `pnpm local:web`                                                     | `http://127.0.0.1:7421`        |
| `agent-web`   | `pnpm local:agent-web`                                               | `http://127.0.0.1:7423`        |

Locally, `reuseExistingServer: !process.env.CI` reuses servers if already running. In CI, servers are always started fresh.

**Note:** The agent **daemon** (`pnpm local:agent start`) is **not** started by Playwright (optional for most UI tests). Tests that need profiles seed host config + `agent:register` via REST.

---

## Run commands

```bash
# All Playwright tests (parallel)
pnpm test:e2e

# UI mode
pnpm test:e2e:ui

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

| `data-pw`                                                                                                                                                                                                                | Where               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `control-shell`                                                                                                                                                                                                          | App shell           |
| `app-header`, `app-nav`, `app-main`, `app-title`                                                                                                                                                                         | Shell chrome        |
| `nav-dashboard`, `nav-session-new`, `nav-sessions`, `nav-repositories`, `nav-schedules`, `nav-agents`                                                                                                                    | Nav                 |
| `page-dashboard`, `dashboard-heading`, `dashboard-new-session`, `dashboard-stats`                                                                                                                                        | Dashboard           |
| `stat-running`, `stat-running-value`, `stat-queued`, `stat-queued-value`, `stat-agents-online`, `stat-agents-online-value`                                                                                               | Dashboard stats     |
| `page-sessions`, `sessions-heading`, `session-filters`, `session-filter-status`, `session-filter-q`                                                                                                                      | Sessions list       |
| `page-session-new`, `session-new-heading`                                                                                                                                                                                | New session         |
| `form-create-session`, `create-session-repository-id`, `create-session-command-profile`, `create-session-prompt`, `create-session-timeout`, `create-session-ref`, `create-session-submit`, `create-session-error`        | Create session form |
| `page-repositories`, `repositories-heading`                                                                                                                                                                              | Repositories        |
| `form-repo-catalog`, `repo-catalog-id`, `repo-catalog-name`, `repo-catalog-url`, `repo-catalog-branch`, `repo-catalog-submit`, `repo-catalog-error`                                                                      | Catalog form        |
| `form-attach-local-repo`, `attach-repo-agent-id`, `attach-repo-id`, `attach-repo-name`, `attach-repo-path`, `attach-repo-branch`, `attach-repo-worktree-id`, `attach-repo-submit`, `attach-repo-ok`, `attach-repo-error` | Attach local repo   |
| `page-schedules`, `schedules-heading`                                                                                                                                                                                    | Schedules           |
| `form-create-schedule`, `schedule-repository-id`, `schedule-name`, `schedule-command-profile`, `schedule-cron`, `schedule-submit`, `schedule-error`                                                                      | Schedule form       |
| `page-agents`, `agents-heading`, `agent-filters`, `agent-filter-online`                                                                                                                                                  | Agents              |

### Agent pane (`services/agent-web`)

| `data-pw`                                                                                                                                                             | Where              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `agent-shell`                                                                                                                                                         | App shell          |
| `nav-status`, `nav-config`                                                                                                                                            | Nav                |
| `page-agent-status`, `agent-status-id`, `agent-drain`                                                                                                                 | Status             |
| `page-agent-config`, `agent-config-heading`                                                                                                                           | Config             |
| `form-add-local-repo`, `add-repo-id`, `add-repo-name`, `add-repo-path`, `add-repo-branch`, `add-repo-worktree-id`, `add-repo-submit`, `add-repo-ok`, `add-repo-error` | Add local repo     |
| `form-host-config-json`, `host-config-json`, `host-config-submit`, `host-config-ok`, `host-config-error`                                                              | Raw JSON inventory |

---

## Test inventory

### Project `control` — baseURL `http://127.0.0.1:7421`

| File                               | Tests                                                  | What it covers                                            |
| ---------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `e2e/control/dashboard.spec.ts`    | loads shell and dashboard stats                        | Shell, heading, stat cards                                |
|                                    | nav links are present                                  | All primary nav `data-pw` links                           |
| `e2e/control/sessions.spec.ts`     | sessions list page and filters                         | List page; status filter updates URL                      |
|                                    | new session form is present                            | Form fields visible                                       |
|                                    | create session via API-backed form when profiles exist | Seeds host config + register via API; submits create form |
| `e2e/control/repositories.spec.ts` | repositories page loads                                | Page + catalog form                                       |
|                                    | create catalog repository with unique id               | Parallel-safe catalog create                              |
| `e2e/control/schedules.spec.ts`    | schedules page and create form                         | Seeds repo via API; creates schedule in UI                |
| `e2e/control/agents.spec.ts`       | agents page loads with filters                         | Page + online filter URL                                  |

### Project `agent` — baseURL `http://127.0.0.1:7423`

| File                       | Tests                                         | What it covers                           |
| -------------------------- | --------------------------------------------- | ---------------------------------------- |
| `e2e/agent/status.spec.ts` | loads agent shell and status page             | Shell, agent id `local-1`, drain control |
| `e2e/agent/config.spec.ts` | config page shows add-repo and raw JSON forms | Both config forms visible                |
|                            | register local repo via form with unique id   | Parallel-safe add-local-repo submit      |

---

## Config reference

- Config file: [`playwright.config.ts`](../playwright.config.ts)
- Test dir: `e2e/`
- Reporter: `list` locally; `github` + `list` when `CI` is set
- Trace: `on-first-retry`; screenshot: `only-on-failure`

---

## CI notes

- Set `CI=1` so servers are not reused and retries apply.
- Ensure Docker is available for DynamoDB Local.
- Install browsers in CI: `pnpm exec playwright install --with-deps chromium`

---

## Adding a test

1. Prefer a new `test()` under the right project folder (`e2e/control` or `e2e/agent`).
2. Use only `getByTestId(...)` / `data-pw` (add attributes in UI if missing).
3. Keep the test self-contained and parallel-safe (unique resource ids).
4. Document it in the **Test inventory** tables above.
