# Web UI

## Overview

Next.js UI for sessions, repositories, worktrees, schedules, hosts (agents), and the Providers/Commands catalog. REST: [api.md](api.md). Live updates: [websocket.md](websocket.md). Credentials and roles: [auth.md](auth.md).

## Authentication

UI-facing login behavior below. Server-side credential types, auth priority, and JWT cookie details: [auth.md](auth.md).

### Login Page

Unauthenticated users are redirected to the login page. The form has two fields:

- **Username** — text input
- **Password** — password input

On submit, the UI calls `POST /auth/login`. On success, the server sets a `auto_harness_session` cookie (HTTP-only, secure, 24h expiry) and the UI redirects to the dashboard.

### Account Types

| Type             | How they log in                                           |
| ---------------- | --------------------------------------------------------- |
| Admin accounts   | Username + password (defined in `HARNESS_ADMINS` env var) |
| User accounts    | Username + password (created by admins via Settings)      |
| Service accounts | Cannot log in to the Web UI — API key auth only           |

### Password Change

Users can change their password from the Settings page. Admin accounts (env var) must be rotated by updating the environment variable and redeploying.

### Session

The session cookie expires after 24 hours. When it expires, the user is redirected to the login page. A "Logout" button in the top nav calls `POST /auth/logout` to clear the cookie.

---

## Dashboard

The dashboard is the landing page and shows a high-level overview:

- **Active sessions** — count and list of currently running sessions
- **Queue depth** — number of sessions waiting for a worktree
- **Connected agents** — agent count with status indicators (online/offline)
- **Worktree utilization** — busy vs idle across all agents
- **New Session** button — opens the session creation form

The dashboard auto-refreshes via WebSocket. Agent and session status changes appear in real-time without page reload.

### Empty States

First-time users or empty views show contextual guidance instead of blank pages:

| View                    | Empty State Message                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Dashboard (no sessions) | "Get started: 1. Add a repository, 2. Connect an agent, 3. Create your first session" with action links |
| Dashboard (no agents)   | "⚠️ No agents connected. Set up a VPS agent →" with link to [agent docs](host-daemon.md)                |
| Session list            | "No sessions yet. Create your first session →" with button                                              |
| Repository list         | "No repositories configured. Add one →" with button                                                     |
| Schedule list           | "No schedules configured. Create one →" with button                                                     |

### Error & Loading States

| State                         | Behavior                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| **Loading**                   | Skeleton placeholders for lists and cards. Spinner for form submissions.                            |
| **API error**                 | Toast notification with error message and retry button. Inline error for form validation.           |
| **WebSocket disconnected**    | Yellow banner at top: "⚠️ Real-time updates paused — reconnecting..." with manual reconnect link    |
| **Agent offline mid-session** | Session card shows warning badge: "Agent disconnected — session may be stale". Force-cancel option. |

---

## Sessions

### Session List

The session list is the primary view for monitoring work. It displays all sessions with the following columns:

| Column     | Description                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status     | Badge: `queued` (yellow), `running` (blue, animated), `completed` (green), `failed` (red), `cancelled` (gray), `timed_out` (orange). If `errorCode === usage_limit`, show a distinct “Usage limit” subtitle on failed sessions |
| Repository | Repository name                                                                                                                                                                                                                |
| Prompt     | Truncated first line of the prompt (click to expand)                                                                                                                                                                           |
| Target     | Resolved target label (`targetLabel`) — a Command's name, or `"<provider> — <account label>"` for a Provider Account                                                                                                           |
| Source     | Origin badge: `api`, `ui`, `webhook`, `schedule`                                                                                                                                                                               |
| Priority   | Numeric priority value                                                                                                                                                                                                         |
| Created    | Relative time (e.g. "2 minutes ago") with full timestamp on hover                                                                                                                                                              |
| Duration   | Elapsed time for running sessions (live), total time for completed                                                                                                                                                             |

### Default View

By default, sessions are sorted by **latest first** (`createdAt` descending). The most recently created session appears at the top.

### Sorting

Sessions can be sorted by clicking column headers:

| Sort Option               | Behavior                                       |
| ------------------------- | ---------------------------------------------- |
| **Latest** (default)      | `createdAt` descending — newest sessions first |
| **Oldest**                | `createdAt` ascending — oldest sessions first  |
| **Priority (high → low)** | `priority` descending — most urgent first      |
| **Priority (low → high)** | `priority` ascending — least urgent first      |

The active sort is indicated by an arrow icon on the column header. Clicking the same column toggles between ascending and descending.

### Search

A search bar above the filter chips provides full-text search across session prompts. Type to search (debounced 300ms), results update in real-time. Uses the `search` query parameter on `GET /sessions`.

Example: searching "date parser" finds all sessions whose prompt contains those words.

### Filtering

Filters are displayed as dropdowns/chips below the search bar. Multiple filters can be combined.

| Filter         | Options                                                                                  | Behavior                                             |
| -------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Status**     | `queued`, `running`, `completed`, `failed`, `cancelled`, `timed_out`, or `all` (default) | Show only sessions matching the selected status      |
| **Repository** | Dropdown of all repositories                                                             | Show only sessions targeting the selected repository |
| **Source**     | `api`, `ui`, `webhook`, `schedule`, or `all`                                             | Filter by session origin                             |
| **Agent**      | Dropdown of connected agents                                                             | Show only sessions assigned to a specific agent      |

Filters and search persist in the URL query string (e.g. `?search=date+parser&status=failed&repo=repo-abc`) so filtered views can be shared or bookmarked.

### Pagination

Sessions are paginated with cursor-based pagination. The list shows 50 sessions per page with "Load more" at the bottom. The API's `cursor` parameter handles efficient DynamoDB pagination.

### Real-Time Updates

The session list is live. When connected via WebSocket:

- New sessions appear at the top of the list automatically
- Status badges update in real-time (e.g. `queued` → `running` → `completed`)
- Running session durations tick live
- No manual refresh needed

---

## Session Detail

Clicking a session in the list opens the session detail view.

### Header

The header displays session metadata:

| Field      | Display                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| Session ID | Monospaced, copyable                                                                        |
| Status     | Animated badge with status color                                                            |
| Repository | Link to repository                                                                          |
| Target     | Monospaced `targetLabel`; once assigned, "Resolved argv" shows the exact spawned array      |
| Agent      | Agent name (if assigned)                                                                    |
| Worktree   | Worktree path (if assigned), "Main checkout" for scheduled sessions                         |
| Priority   | Numeric value                                                                               |
| Source     | Origin badge                                                                                |
| Created    | Full timestamp                                                                              |
| Started    | Full timestamp (if started)                                                                 |
| Duration   | Live elapsed time (running) or total time (completed)                                       |
| Timeout    | Configured timeout (e.g. "30 min"). Progress bar shows time remaining for running sessions. |
| Exit Code  | Shown on completion — `0` (green) or non-zero (red)                                         |

### Prompt

The initial prompt is displayed in a highlighted, read-only block below the header. The full prompt text is shown — not truncated. For long prompts, the block is scrollable.

```
┌─ Prompt ─────────────────────────────────────────────────────┐
│                                                              │
│  Fix the failing test in src/utils.test.ts. The test         │
│  "should parse dates correctly" is failing because the       │
│  date parser doesn't handle timezone offsets. Update the     │
│  parser to support ISO 8601 timezone formats.                │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Live Log Viewer

Below the prompt, a terminal-like log viewer displays session output. This is the core feature of the session detail view.

**Implementation:** Uses [xterm.js](https://xtermjs.org/) for full terminal emulation — ANSI colors, cursor movement, progress bars, and interactive output from AI CLIs render correctly.

**Behavior:**

1. **On page load** — fetches historical logs via `GET /sessions/:id/logs` and renders them in the terminal
2. **For running sessions** — opens a WebSocket connection and subscribes to `session:subscribe`. The server replays the last 100 buffered lines, then streams new output in real-time.
3. **For completed sessions** — displays the full log history (read-only, no WebSocket needed)
4. **Stream tabs** — toggle between `stdout`, `stderr`, `system`, or `all` (interleaved, default)

**Terminal controls:**

| Control    | Function                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Search     | `Ctrl+F` to search within log output                                                                              |
| Copy       | Select text and copy. Right-click context menu.                                                                   |
| Scroll     | Scroll up to view history. Auto-scroll snaps to bottom when new output arrives (unless the user has scrolled up). |
| Font size  | `Ctrl+`/`Ctrl-` to adjust                                                                                         |
| Fullscreen | Expand the terminal to fill the viewport                                                                          |
| Download   | Download the full log as a `.txt` file                                                                            |

**Status transitions** are displayed as system messages in the terminal:

```
[system] Session started at 2026-08-01T12:00:05Z
[system] Running setup script...
[system] Setup complete. Spawning: codex -p
... stdout/stderr output ...
[system] Process exited with code 0
[system] Session completed at 2026-08-01T12:05:30Z
```

### Cancel Button

For `queued` or `running` sessions, a "Cancel Session" button is shown. It calls `POST /sessions/:id/cancel` and the status updates in real-time.

### Re-run, Resume & Clone

Action buttons on terminal sessions (`completed`, `failed`, `cancelled`, `timed_out`):

| Button           | Behavior                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resume**       | `POST /sessions/:id/resume` — new session **pinned to the same agent + worktree**; agent tries to continue in that workspace. Optional prompt for “continue with…”. Waits if that worktree is busy. |
| **Re-run**       | `POST /sessions/:id/clone` — identical new session; **any** matching worktree (round-robin). Fresh setup.                                                                                           |
| **Clone & Edit** | Opens the "New Session" form pre-filled with this session's fields; user edits before submit (not pinned unless they use Resume).                                                                   |

**Resume vs re-run:** resume keeps the disk/context on the original runner; re-run is a clean independent attempt. See [api.md — resume](api.md#post-sessionsidresume).

---

## Create Session

The "New Session" form can be opened from the dashboard or the sessions list page. It submits via `POST /sessions` with `source: 'ui'`.

### Form Fields

| Field      | Type               | Required | Description                                                                                                                          |
| ---------- | ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Repository | Dropdown           | ✓        | Select from available repositories                                                                                                   |
| Prompt     | Textarea           | ✓        | Multi-line prompt for the AI agent. Supports markdown preview.                                                                       |
| Target     | Dropdown           | ✓        | `<optgroup>`s: Provider accounts, then Commands — sourced from `GET /session-targets`; no free-text option, never arbitrary commands |
| Timeout    | Dropdown + number  | ✓        | Preset options (5 min, 15 min, 30 min, 1 hour) with custom input. Required field.                                                    |
| Priority   | Slider (0–100)     | ✗        | Default: 0. Visual indicator: low / normal / high / critical                                                                         |
| Labels     | Multi-select chips | ✗        | Filter which worktrees can run this session. Populated from available labels across connected agents.                                |

### Submission

On submit:

1. The form validates all required fields
2. Sends `POST /sessions` with the form data
3. On success, redirects to the new session's detail view
4. The session appears in the list and begins streaming logs once an agent picks it up

---

## Schedules

### Schedule List

Displays all configured schedules in a table:

| Column     | Description                                                                  |
| ---------- | ---------------------------------------------------------------------------- |
| Name       | Schedule name                                                                |
| Repository | Target repository                                                            |
| Target     | Resolved `targetLabel`                                                       |
| Cron       | Human-readable schedule (e.g. "Every day at 6:00 AM") with raw cron on hover |
| Enabled    | Toggle switch                                                                |
| Last Run   | Relative time + status badge (success/failed)                                |
| Next Run   | Absolute time for next scheduled execution                                   |

### Schedule Detail

- Edit schedule fields (name, target, cron, enabled)
- Run history — list of past sessions created by this schedule, with status and links to session detail
- "Run Now" button — manually triggers via `POST /schedules/:id/trigger`, then redirects to the created session

### Create/Edit Schedule Form

| Field      | Type       | Required | Description                                                                                                 |
| ---------- | ---------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| Repository | Text input | ✓        | Target repository id                                                                                        |
| Name       | Text input | ✓        | Human-readable schedule name                                                                                |
| Target     | Dropdown   | ✓        | Same `SessionTargetSelect` as Create Session — Provider account or standalone Command, never a shell string |
| Cron       | Text input | ✓        | Raw 5-field cron expression                                                                                 |
| Enabled    | Toggle     | ✗        | Default: enabled                                                                                            |

---

## Repositories

### Repository List

Table of configured repositories:

| Column         | Description                   |
| -------------- | ----------------------------- |
| Name           | Repository name               |
| URL            | Git URL (truncated, copyable) |
| Default Branch | e.g. `main`                   |
| Sessions       | Count of total sessions       |
| Worktrees      | Count of associated worktrees |
| Schedules      | Count of associated schedules |

### Add/Edit Repository

Form with fields: name, git URL, default branch, setup script (optional).

### Repository Detail

Tabs: **Sessions** (default) · **Worktrees** · **Provider accounts** · **Settings**.

The Provider accounts tab shows, for each host the repository is attached to, a labeled `ProviderScopeTable` block: every host-attached Provider Account's effective **Enabled** state (tri-state: inherited-on/inherited-off/explicit, with a "reset to inherited" option), which scope that value came from (**Inherited from**), and the **Effective command** with an inline override picker scoped to that account's provider's own commands. A repository can be attached to several hosts, so this tab can render several blocks.

---

## Worktrees

Fleet-wide worktrees view, grouped by repository. Each worktree's detail page has the same tab set as Repository Detail (Sessions, Provider accounts, Settings) — the Provider accounts tab is a single `ProviderScopeTable` (a worktree belongs to exactly one host, so there's only one block, and the worktree scope wins over its repository's).

---

## Hosts

### Host List

Table of registered hosts: agent id, online/offline status, attached repository count, drain control.

### Host Detail

Tabs: **Overview** (status, repository/worktree counts) · **Repositories & Worktrees** (attach/detach, add worktrees) · **Provider accounts**.

The Provider accounts tab (replaces the old "Command profiles" tab) lists every Provider Account attached to this host with its effective command (provider default unless overridden here) and a per-account override picker, plus a form to attach any not-yet-attached catalog account. This is the **only** place a Provider Account becomes eligible for scheduling on a host — the repository/worktree Provider accounts tabs above can only narrow or override an already-attached account, never attach a new one.

---

## Providers

### Provider List

Table: name, default command, attached-account count, owned-command count. "Add provider" opens a dialog that creates the provider **and** its default command in one submit — a provider is never left without a default, since that would make every account under it unresolvable.

### Provider Detail

Tabs: **Accounts** (add/remove catalog accounts, each showing how many hosts it's attached to) · **Commands** (this provider's owned commands, plus a default-command selector and an inline create form) · **Settings** (rename; delete — disabled while any account or command still references this provider, to avoid a 409 round-trip).

---

## Commands

### Command List

Table: name, argv, owning provider (or "—" for standalone), append-prompt flag.

### Command Detail

Edit name/argv/append-prompt/provider inline. Delete is disabled while the command is some provider's default command (the one guard the backend enforces today — a "referenced by a scope override" guard is not yet implemented server-side).

---

## Settings

### Service Accounts

- List all service accounts with name, role, allowed repositories, and creation date
- Create new service account — name, role dropdown (`read-only`, `operator`, `admin`), repository scope
- API key shown once in a modal after creation with copy button
- Delete service account with confirmation

### Connected Agents

- List of agents with status (online/offline), worktree count, busy worktrees, connection time
- Click to expand — shows worktree details (path, labels, status, current session)

---

## Keyboard Shortcuts

| Shortcut  | Action                            |
| --------- | --------------------------------- |
| `N`       | Open new session form             |
| `S`       | Focus search / filter             |
| `Esc`     | Close modal / form                |
| `J` / `K` | Navigate session list (down / up) |
| `Enter`   | Open selected session             |
| `?`       | Show keyboard shortcuts help      |
