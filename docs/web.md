# Web UI

## Overview

Next.js UI for sessions, repositories, worktrees, schedules, hosts, the Providers/Commands catalog, and admin-only global settings. REST: [api.md](api.md). Live updates: [websocket.md](websocket.md). Credentials and roles: [auth.md](auth.md).

The UI runs against the supported local control plane. Cloud-hosted UI/API behavior remains a
target until the AWS runtime has a deploy path and account-backed verification. Sections that say
**Target** retain the intended product behavior without claiming it is already shipped.

### Shell & Navigation

The app title links back to `/`. Nav items are grouped into **Operate** (Dashboard, New session,
Sessions, Schedules), **Catalog** (Repositories, Providers, Commands), **Fleet** (Worktrees, Hosts),
and **Settings** — one horizontally-scrolling row, not a wrapping grid, so it never pushes page
content down at narrow widths. The theme toggle, keyboard-shortcuts button, logout (only when
`HARNESS_AUTH_MODE=required`), and the page subtitle live in a slim secondary row below title+nav,
not competing with navigation for space in the primary header row. The host pane's own shell reuses
the same chrome with a flat (ungrouped) nav, since its 3-item nav doesn't need grouping. That pane
is **debug-only** and has no login form — a visible badge and subtitle tell operators to use the
control plane. A missing session cookie (`HARNESS_AUTH_MODE=required`) or a 401 from
`/api/v1/hosts` (typical when opening a remote `WebUrl` whose cookies live on the CloudFront
control-plane domain) renders a short HTML explanation instead of a raw `authentication required`
body or a half-empty shell.

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

The session cookie expires after 24 hours. When it expires, the user is redirected to the login page. When `HARNESS_AUTH_MODE=required`, a "Logout" button in the top nav calls `POST /auth/logout` to clear the cookie. The button is hidden when authentication is disabled.

---

## Dashboard

The dashboard is the landing page and shows a high-level overview:

- **Active sessions** — count and list of currently running sessions
- **Queue depth** — number of sessions waiting for a worktree
- **Connected agents** — agent count with status indicators (online/offline)
- **Worktree utilization** — busy vs idle across all agents
- **New Session** button — opens the session creation form

The dashboard refreshes a bounded sessions/hosts/worktrees snapshot every five seconds. Agent,
session, and utilization changes appear without a page reload; a paused banner retains the last
successful snapshot when polling fails and offers an immediate retry.

Running and Queued counts come from dedicated `GET /sessions?status=running&limit=100` /
`?status=queued&limit=100` requests, not from filtering the "Recent sessions" list — so a
long-queued session is still counted even after enough newer sessions have pushed it out of the
recent-activity window. Each count is exact up to 100; past that bound the card shows "100+"
instead of a number that would otherwise look precise but isn't.

### Empty States

First-time users or empty views show contextual guidance instead of blank pages:

| View                    | Empty State Message                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Dashboard (no sessions) | "Get started: 1. Add a repository, 2. Connect a host, 3. Create your first session" with action links |
| Dashboard (no hosts)    | "No hosts connected. Set up a VPS host →" with link to the Hosts setup view                           |
| Session list            | "No sessions yet. Create your first session →" with button                                            |
| Repository list         | "No repositories configured. Add one →" with button                                                   |
| Schedule list           | "No schedules configured. Create one →" with button                                                   |

### Error & Loading States

| State                         | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Loading**                   | The shared route fallback and primary list route fallbacks announce busy loading regions and render hidden-from-AT skeletons. Forms use pending labels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Route error**               | The shared error boundary focuses a generic alert and offers a Retry button without exposing internal error text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **API/form error**            | Failed primary list requests replace empty-state content with a contextual alert and retry action. Detail pages apply the same pattern per section — a failed fetch feeding one section of a page (e.g. a host's provider accounts, or a session's logs) renders that section's own contextual alert and retry, rather than degrading to a silent empty state or, worse, being mistaken for the section genuinely having no data. Failed command, provider, and repository deletes show a persistent alert toast with the API message and an explicit retry action. Other page and form errors use alert semantics where state can change in place; validation remains inline. |
| **WebSocket disconnected**    | Yellow banner at top: "⚠️ Real-time updates paused — reconnecting..." with manual reconnect link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Agent offline mid-session** | Session detail polls session/host state, shows an accessible "Agent disconnected — session may be stale" warning, and offers a confirmed Force-cancel. Force-cancel uses ordinary control-plane cancellation; it cannot confirm that the disconnected host process stopped, and its worktree stays reserved for safe reconciliation.                                                                                                                                                                                                                                                                                                                                           |

---

## Sessions

### Session List

The session list is the primary view for monitoring work. It displays all sessions with the following columns:

| Column     | Description                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Badge: `queued` (yellow), `running` (blue, animated), `completed` (green), `failed` (red), `cancelled` (gray), `timed_out` (orange). Show distinct “Usage limit” and “Queue expired” subtitles for `usage_limit` and `queue_expired`. |
| Repository | Linked repository name in both control and host lists; fall back to the stable repository id if its catalog entry is unavailable                                                                                                      |
| Prompt     | Truncated first line of the prompt (click to expand)                                                                                                                                                                                  |
| Target     | Configured target/fallback chain and resolved route — Provider targets show the selected provider/account, Command targets show the command; providerless commands are marked pure CLI                                                |
| Source     | Origin badge: `api`, `ui`, `webhook`, `schedule`                                                                                                                                                                                      |
| Priority   | Numeric priority value                                                                                                                                                                                                                |
| Created    | Relative time (e.g. "2 minutes ago") with full timestamp on hover                                                                                                                                                                     |
| Duration   | Elapsed time for running sessions (live), total time for completed                                                                                                                                                                    |

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

A search bar above the filter chips searches the sessions on the currently loaded pages. Enter a query and press Enter or move focus away from the field to apply it; it is not sent as an API query or backed by DynamoDB full-text search. Matching is case-insensitive across session and repository IDs (and the repository name when supplied), status and terminal reason, prompt, target and fallback labels/IDs, resolved route and host/worktree IDs, queue expiry, source, priority, required labels, concurrency ID, and created/started/completed timestamps.

Example: searching "date parser" filters the currently loaded pages' session prompts for those words.

### Filtering

Filters are displayed as dropdowns/chips below the search bar. Multiple filters can be combined.

| Filter             | Options                                                                                  | Behavior                                             |
| ------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Status**         | `queued`, `running`, `completed`, `failed`, `cancelled`, `timed_out`, or `all` (default) | Show only sessions matching the selected status      |
| **Repository**     | Dropdown of all repositories                                                             | Show only sessions targeting the selected repository |
| **Source**         | `api`, `ui`, `webhook`, `schedule`, or `all`                                             | Filter by session origin                             |
| **Concurrency ID** | Exact active-run identity (when present); duplicate creates link to the existing session | Inspect dedupe/concurrency behavior                  |
| **Agent**          | Dropdown of connected agents                                                             | Show only sessions assigned to a specific agent      |

Filters and client-side search persist in the URL query string (e.g. `?q=date+parser&status=failed&repositoryId=repo-abc&source=api&hostId=agent-1`) so filtered views can be shared or bookmarked. The `q` value is applied only to rows on the currently loaded pages and is never sent to `GET /sessions`.

### Pagination

Sessions are paginated with cursor-based pagination. The list initially shows 50 sessions and
appends the next API page when "Load more" is selected. Loaded pages are deduplicated by session id,
and loading another page does not replace the active filter/sort/search URL. The API's `cursor`
parameter handles efficient DynamoDB pagination; bookmarked cursor URLs remain valid starting bounds.

### Real-Time Updates

The control-plane session list refreshes its currently loaded bounded API pages every five seconds:

- New sessions appear at the top of the first page automatically
- Status badges and host assignment update in place
- Active filters, cursor bounds, appended rows, and client-side search remain applied
- A request failure keeps the last successful rows and exposes a retry action

The detail log stream continues to use the viewer WebSocket. List and dashboard polling is
deliberately bounded to their existing REST page sizes rather than opening fleet-wide viewer
subscriptions.

---

## Session Detail

Clicking a session in the list opens the session detail view.

### Header

The header displays session metadata:

| Field      | Display                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session ID | Monospaced, copyable                                                                                                                                                                                    |
| Status     | Badge with status color; queued sessions note that the scheduler runs about once a minute; terminal `usage_limit` and `queue_expired` errors include distinct “Usage limit” and “Queue expired” reasons |
| Repository | Link to repository                                                                                                                                                                                      |
| Target     | Configured target/fallback chain; once assigned, show selected Provider Account, Command, Host, Worktree, and exact resolved argv                                                                       |
| Queue      | Fixed `queueExpiresAt` timestamp/countdown while queued; `queue_expired` is terminal and fallback attempts never extend the deadline                                                                    |
| Agent      | Agent name (if assigned)                                                                                                                                                                                |
| Worktree   | Worktree path (if assigned), "Main checkout" for scheduled sessions                                                                                                                                     |
| Priority   | Numeric value                                                                                                                                                                                           |
| Source     | Origin badge                                                                                                                                                                                            |
| Created    | Full timestamp                                                                                                                                                                                          |
| Started    | Full timestamp (if started)                                                                                                                                                                             |
| Duration   | Live elapsed time (running) or total time (completed)                                                                                                                                                   |
| Timeout    | Configured timeout (e.g. "30 min"). Progress bar shows time remaining for running sessions.                                                                                                             |
| Exit Code  | Shown on completion — `0` (green) or non-zero (red)                                                                                                                                                     |

### Prompt

The initial prompt is displayed in a highlighted, read-only block below the header. The full prompt text is shown — not truncated. For long prompts, the bounded block is scrollable and keyboard-focusable so keyboard users can inspect all of its content.

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

**Current implementation:** a read-only [xterm.js](https://xtermjs.org/) viewer (`SessionTerminalViewer`,
shared from `modules/ui`) renders the assigned CLI's merged PTY-backed log chunks, including ANSI
colors and cursor control sequences, and live-tails over the viewer WebSocket. Search, selectable
text, scrollback, font sizing, fullscreen, and `.txt` download controls are available. The viewer
remains deliberately non-interactive: it does not send browser input to the running process. Git,
setup, and hook output remains pipe-based.

The host pane's session detail view (`:7422`) uses the same viewer for the same reason — a plain-text
log dump can't render ANSI colors or cursor-addressed output (progress bars, TUI redraws), so
assigned CLI output there used to print as literal escape bytes. Host pane fetches logs once at page
load rather than live-tailing (it has no WebSocket viewer infrastructure), so its controls work
against a static snapshot — search, font sizing, fullscreen, and download all function identically,
there's just no live update after the initial fetch.

**Behavior:**

1. **On page load** — fetches bounded historical logs via `GET /sessions/:id/logs` and renders them in the terminal.
2. **Live tail** — obtains a short-lived viewer ticket through the authenticated web origin, then opens the read-only API `/ws/viewer` socket and subscribes with `session:subscribe`. It resumes from the last `timestampSeq` after reconnect, deduplicates replay, orders entries by cursor, and retains at most 1,000 live entries.
3. **Lifecycle and errors** — shows `Connecting`, `Live — <status>` while the session is still `queued` or `running`, the terminal status with no `Live —` prefix once it has ended, `Reconnecting`, or an explicit unavailable/paused error. A later `session:subscribed` `queued` or `running` does not replace a terminal status already loaded from REST. Queued sessions also note that the scheduler runs about once a minute. The connection retries with capped exponential backoff.
4. **On leave** — sends `session:unsubscribe` before closing the browser socket.

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
[system] Session started at 2026-08-01T12:00:05.000Z
[system] Running setup script...
[system] Setup complete.
[system] Spawning: codex (argument count: 1)
... stdout/stderr output ...
[system] Process exited with code 0
[system] Session completed at 2026-08-01T12:05:30.000Z
```

The setup lines appear only when a setup script runs successfully. Spawn messages include only the
executable and argument count; command arguments and prompts are never copied into system logs. A
terminated process without an exit code is reported as `Process exited without an exit code`, and
the final timestamped marker names the actual terminal status (`completed`, `failed`, `cancelled`,
or `timed_out`).

### Cancel Button

For `queued` or `running` sessions, a "Cancel session" button is shown. It calls `POST /sessions/:id/cancel` and reads "Cancelling…" with a busy state while the request is pending; the status then updates in real-time.

### Re-run, Resume & Clone

Action buttons on terminal sessions (`completed`, `failed`, `cancelled`, `timed_out`):

Each action exposes its pending state with a descriptive label (`Resuming…`, `Re-running…`, or `Archiving…`) instead of an unlabeled spinner glyph.

| Button           | Behavior                                                                                                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resume**       | `POST /sessions/:id/resume` — new session pinned to the same host; any eligible worktree checks out the source ref when present (otherwise default branch), skips setup, and runs native resume or the frozen command. Optional prompt, timeout, and priority.                                                                          |
| **Re-run**       | `POST /sessions/:id/clone` — clean independent rerun with a new id; snapshots only replayable inputs, does not copy concurrency/runtime/log/secret state, and uses **any** matching worktree (round-robin). Fresh setup.                                                                                                                |
| **Clone & Edit** | Opens the "New Session" form with a bounded source-session id. The server fetches that scoped session and pre-fills only repository, prompt, target/fallbacks, queue TTL/timeout, priority, required labels, and ref. It never copies concurrency, runtime, logs, secrets, metadata, or resume state, and creates nothing until submit. |

**Resume vs re-run:** resume keeps host affinity and CLI state, but re-establishes the source ref in any eligible worktree; re-run is a clean independent attempt. See [api.md — resume](api.md#post-sessionsidresume).

---

## Create Session

The "New Session" form can be opened from the dashboard or the sessions list page. Its required Repository picker is populated from the scoped repository catalog and selects the first repository alphabetically for a fresh form. The form cannot submit until at least one repository and one routing target are available. Clone & Edit retains its source repository selection, including a bounded source value when that repository is absent from the current catalog response. It submits via `POST /sessions` with `source: 'ui'`.

### Form Fields

| Field          | Type               | Required | Description                                                                                                                        |
| -------------- | ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Repository     | Dropdown           | ✓        | Select from available repositories                                                                                                 |
| Prompt         | Textarea           | ✓        | Multi-line prompt sent to the Session. Supports markdown preview.                                                                  |
| Target         | Dropdown           | ✓        | Primary Provider or Command target, sourced from `GET /session-targets`; no free-text option                                       |
| Fallbacks      | Ordered list       | ✗        | Add, remove, and reorder fallback Provider/Command targets; tried only when the preceding target has no eligible route             |
| Queue TTL      | Number input       | ✗        | Absolute queue lifetime in seconds; default 691200 (8 days), never reset by fallback attempts                                      |
| Timeout        | Dropdown + number  | ✓        | Presets for 5 min, 15 min, 30 min, and 1 hour. Custom reveals a required positive-seconds input. The API receives numeric seconds. |
| Priority       | Slider (0–100)     | ✗        | Default: 0. Visual indicator: low / normal / high / critical                                                                       |
| Labels         | Multi-select chips | ✗        | Filter which worktrees can run this session. Populated from available labels across connected agents.                              |
| Concurrency ID | Text input         | ✗        | Optional global exact-match identity for deduplication and concurrency. A duplicate active request returns the existing session.   |

### Submission

On submit:

1. The form validates all required fields
2. Sends `POST /sessions` with the form data
3. On success, redirects to the new session's detail view; a duplicate response (`created: false`) redirects to the existing session
4. The session appears in the list and begins streaming logs once an agent picks it up

---

## Schedules

### Schedule List

Displays all configured schedules in a table:

| Column         | Description                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name           | Schedule name                                                                                                                                                                   |
| Repository     | Target repository                                                                                                                                                               |
| Target         | Resolved `targetLabel`                                                                                                                                                          |
| Cron           | Human-readable UTC schedule for common patterns (e.g. "Every day at 6:00 AM UTC"), or "Custom schedule", with the raw cron expression on hover and as an accessible description |
| Enabled        | Accessible toggle switch; saves immediately and preserves the current state with a retry message if the update fails                                                            |
| Last Run       | Relative time + status badge (success/failed)                                                                                                                                   |
| Next Run       | Absolute time for next scheduled execution                                                                                                                                      |
| Concurrency ID | Exact identity used to prevent overlapping automatic/manual runs; defaults to `schedule-${scheduleId}` for automatic fires                                                      |

### Schedule Detail

- Edit schedule fields (name, prompt, target, cron, enabled)
- Run history — list of past sessions created by this schedule, filtered by persisted `scheduleId`
  provenance rather than a concurrency ID that may be shared with other task sources. Each row uses the
  shared semantic status badge, an exact UTC creation timestamp, and terminal duration when available.
- "Run now" button — manually runs the schedule via `POST /schedules/:id/trigger`, shows "Running…" while pending, then redirects to the created session
- A duplicate "Run now" returns the existing active session (`200`, `created: false`) rather than queuing another run

### Create/Edit Schedule Form

| Field      | Type         | Required | Description                                                                                 |
| ---------- | ------------ | -------- | ------------------------------------------------------------------------------------------- |
| Repository | Text input   | ✓        | Target repository id                                                                        |
| Name       | Text input   | ✓        | Human-readable schedule name                                                                |
| Prompt     | Textarea     | ✗        | Prompt sent to the CLI on each fire. Missing or blank stays empty; never `scheduled:<name>` |
| Target     | Dropdown     | ✓        | Same `SessionTargetSelect` as Create Session — Provider or Command, never a shell string    |
| Fallbacks  | Ordered list | ✗        | Ordered fallback Provider/Command targets                                                   |
| Queue TTL  | Number input | ✗        | Per-fire absolute queue lifetime; default 8 days                                            |
| Cron       | Text input   | ✓        | Raw 5-field cron expression                                                                 |
| Enabled    | Toggle       | ✗        | Default: enabled                                                                            |

---

## Repositories

### Repository List

Expandable hierarchy of configured repositories and their worktrees. Each repository header shows:

| Column         | Description                   |
| -------------- | ----------------------------- |
| Name           | Repository name               |
| URL            | Git URL (truncated, copyable) |
| Default Branch | e.g. `main`                   |
| Sessions       | Count of total sessions       |
| Worktrees      | Count of associated worktrees |
| Schedules      | Count of associated schedules |

### Add/Edit Repository

Both Add and Edit forms include name, git URL, default branch, and an optional multiline setup
script.

### Repository Detail

Tabs: **Sessions** (default) · **Worktrees** · **Provider accounts** · **Settings**.

The Provider accounts tab shows, for each host the repository is attached to, a labeled `ProviderScopeTable` block: every host-attached Provider Account's effective **Enabled** state (tri-state: inherited-on/inherited-off/explicit, with a "reset to inherited" option), which scope that value came from (**Inherited from**), and the **Effective command** with an inline override picker scoped to that account's provider's own commands. Cooldown state is global and read-only here. A repository can be attached to several hosts, so this tab can render several blocks.

---

## Worktrees

Fleet-wide worktrees view, grouped by repository. Each worktree's detail page has the same tab set as Repository Detail (Sessions, Provider accounts, Settings) — the Provider accounts tab is a single `ProviderScopeTable` (a worktree belongs to exactly one host, so there's only one block, and the worktree scope wins over its repository's).

---

## Hosts

### Host List

The **Add host** form is shown only to an unscoped admin (and in loopback when authentication is
disabled). Operators run sessions on existing host slots; they do not create them. Submitting the
form as a non-admin surfaces "Admins create host slots; operators run sessions." instead of a raw
JSON `FORBIDDEN` body.

The connected-host fleet table shows each host id, online/offline status, attached repository count,
whether host configuration exists, connection time (relative, full timestamp on hover), worktree
count, busy worktrees, and drain control — a scanning view, not a drill-down one. Detected restart
count and daemon start time live on that host's own detail page (Overview tab) instead, since a
list row showing more facts than its own detail page is backwards. Expand a host's worktree summary
to inspect each worktree's path, labels, status, current session, and links to its repository,
worktree, and active session details.

### Host Detail

Tabs: **Overview** (status, repository/worktree counts, connection time, and daemon restart
observability) · **Repositories & Worktrees** (attach/detach, add worktrees) · **Provider accounts**
· **Advanced** (raw inventory JSON editor).

The Overview tab's Daemon block shows the detected restart count, daemon start time, and last-restart
time (all relative, full timestamp on hover). A daemon process keeps one opaque instance id across
WebSocket reconnects; the control plane counts a restart only when a later registration changes a
previously known instance id. Legacy daemons establish no baseline. This is local API/UI
observability, not an outbound alert and not permission to restart a host.

An offline host's Overview tab also shows **Connect this host**: the quoted env +
`pnpm local:daemon start` foreground command, plus the same quoted env with
`pnpm local:daemon install-service` as the persist path. Copy uses the foreground command.
The panel states that you need **two** service-account keys (create both on Settings): a
**bound** key for the daemon, and an **unbound** operator key for `POST /sessions`. A bound
key 404s on session create on purpose.

Worktree status for this tab's Repositories & Worktrees section comes from `GET
/api/v1/worktrees?hostId=<id>` — filtered server-side, not fetched unfiltered and grouped in JS —
the same filter host pane's own repository/worktree pages use for their single host. **Add
worktree** records the name and absolute path on the control plane only — it does not mkdir the
directory. The daemon runs `git worktree add` when the host is online.

The Provider accounts tab (replaces the old "Command profiles" tab) lists every Provider Account attached to this host with its effective command (provider default unless overridden here) and a per-account override picker, plus a form to attach any not-yet-attached catalog account. This is the **only** place a Provider Account becomes eligible for scheduling on a host — the repository/worktree Provider accounts tabs above can only narrow or override an already-attached account, never attach a new one. An account's usage-limit cooldown is global across hosts; clearing it on the Provider page makes it eligible everywhere immediately.

The Advanced tab's raw JSON editor (`HostConfigForm`, shared with the host pane's own Settings page) replaces the whole `repositories`/`providerAccounts` document on save, conditioned on the inventory's version at the time the tab was loaded — if another edit landed in the meantime, the save is rejected with a distinct "this host's inventory changed since you loaded this page" message instead of either an opaque error or a silent overwrite. Prefer the per-repository/per-account forms elsewhere on this page; this editor exists for bulk edits (e.g. seeding many worktrees at once).

---

## Providers

### Provider List

Table: name, default command, attached-account count, owned-command count. "Add provider" opens a dialog that creates the provider **and** its default command in one submit — a provider is never left without a default, since that would make every account under it unresolvable. The default command **name** is a catalog label (e.g. `claude-print`), not the binary on disk; the first argv token is the executable.

### Provider Detail

Tabs: **Accounts** (add/remove catalog accounts, each showing how many hosts it's attached to) · **Commands** (this provider's owned commands, plus a default-command selector and an inline create form) · **Settings** (rename; delete — disabled while any account or command still references this provider, to avoid a 409 round-trip). The account create form's cooldown pauses that account on `usage_limit` (default 18000s / 5 hours), not as a general retry.

---

## Commands

### Command List

Table: name, argv, owning provider (or "—" for standalone), append-prompt flag.

### Command Detail

Edit name/argv/append-prompt/provider inline. Delete is disabled while the command is some provider's default command. The API also rejects deletion with `409 Conflict` while the command is referenced by a host, repository, or worktree Provider Account command override; the confirmation control announces the precise blocking scope so the override can be cleared first.

---

## Settings

Authenticated users retain access to the control-plane Settings page, account
details, password controls, and the Settings nav item. Only the Slack panel is
restricted to an unscoped admin; it renders an accessible permission error for a
valid but unauthorized account. Missing authentication redirects to `/login`
with only a relative, validated `returnTo` path. When authentication is disabled
(`HARNESS_AUTH_MODE` unset or not `required`), Settings shows an "Authentication
disabled" card and does not render user-account or service-account management
chrome.

### Slack configuration

Settings displays only redacted Slack state: whether each secret is configured,
the default channel, enabled state, and notification toggles. Bot tokens and
signing secrets are write-only password inputs with no initial value and are
cleared after successful create or complete replacement. Replacement always
requires the bot token again; the UI cannot recover or preserve a prior secret.

The page supports create, complete replacement, and explicitly confirmed
delete. A persistent warning explains that configuration alone does not send
Slack messages; OAuth, delivery, inbound verification, and session threads are
separate capabilities and are not enabled by this UI.

### Service Accounts

- List all service accounts with name, role, allowed repositories, and creation date
- Create new service account — name, role dropdown (`read-only`, `operator`, `admin`), repository scope
- API key shown once in a modal after creation with copy button
- Delete service account with confirmation
- Rotate by creating an overlapping replacement with identical role/scope, showing its key once,
  and keeping the old key active until the admin confirms every consumer has been updated

### User Accounts

- List all human user accounts with username and role
- Create a user account with an initial write-only password and role (`read-only`, `operator`, `admin`)
- Delete a user account with explicit confirmation
- Only unscoped admins can manage users; other authenticated users see a permission boundary
- Users change their own password after signing in; passwords and hashes are never displayed

---

## Hosts

The fleet list shows each host slot's online/offline status. When any host is offline, a notice
explains that host slots persist in Foundation tables across `teardown` (not `purge`), so a restore
can show leftover offline slots. Delete unused hosts, or purge the environment to wipe them.

---

## Keyboard Shortcuts

The authenticated control-plane shell provides the shortcuts below. Except for `Esc`, they are
ignored while focus is in an input, textarea, select, combobox, textbox role, or editable element.
A visible Shortcuts button provides the same help dialog without requiring keyboard discovery. The
`G` prefix is announced to assistive technology and expires after 1.5 seconds. Session-row
navigation follows the current filtered order and moves focus with the selected row.

| Shortcut | Action                                         |
| -------- | ---------------------------------------------- |
| `N`      | Open new session                               |
| `S`      | Focus session search                           |
| `J`      | Select next session                            |
| `K`      | Select previous session                        |
| `Enter`  | Open selected session                          |
| `?`      | Open shortcut help                             |
| `G D`    | Go to Dashboard                                |
| `G N`    | Go to New session                              |
| `G S`    | Go to Sessions                                 |
| `G R`    | Go to Repositories                             |
| `G W`    | Go to Worktrees                                |
| `G P`    | Go to Providers                                |
| `G C`    | Go to Commands                                 |
| `G A`    | Go to Schedules                                |
| `G H`    | Go to Hosts                                    |
| `G T`    | Go to Settings                                 |
| `Esc`    | Close shortcut help or leave an editable field |
