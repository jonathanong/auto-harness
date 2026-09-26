# Agent CLIs

How to install, log in, and wire each supported agent CLI into Auto Harness as a catalog
Provider so the host daemon can run it non-interactively. Covers **claude**, **codex**,
**cursor-agent**, and **grok**. `gemini` is installed on some hosts but is intentionally not
documented here — there is no catalog preset for it.

The non-interactive argv the harness actually spawns comes from one file:
[`services/web/src/lib/catalog-command-defaults.ts`](../services/web/src/lib/catalog-command-defaults.ts).
Everything under "Preset" below is copied from it verbatim; if this page and that file ever
disagree, the file wins.

Verified locally against `claude 2.1.278 (Claude Code)`, `codex-cli 0.154.0`,
`cursor-agent 2026.09.10-fd3934a`, and `grok 1.0.30` — CLI flags drift between releases, so
re-check `<cli> --help` if a command below stops matching what you see.

## Quick reference

| CLI         | Binary         | Non-interactive login check                          | Catalog preset (`commandName`) | `appendPromptSeparator` |
| ----------- | -------------- | ---------------------------------------------------- | ------------------------------ | ----------------------- |
| Claude Code | `claude`       | `claude auth status`                                 | `claude-print`                 | `true`                  |
| Codex       | `codex`        | `codex login status`                                 | `codex-exec`                   | `true`                  |
| Cursor      | `cursor-agent` | `cursor-agent status --format json` (alias `whoami`) | `cursor-print`                 | `true`                  |
| Grok        | `grok`         | none — see [Grok](#grok)                             | `grok-print`                   | `false`                 |

## How prompts reach the CLI

Two fields on a catalog Command control how the session prompt is turned into argv at dispatch
(`services/web/src/lib/catalog-command-defaults.ts`, `services/api/src/control-plane-session-target.ts`):

- **`appendPrompt`** — when `true`, the prompt is appended as the final argv element at dispatch.
  All four presets set this `true`.
- **`appendPromptSeparator`** — when `true`, a literal `--` is inserted immediately before the
  appended prompt: `[...argv, "--", prompt]`. When `false`: `[...argv, prompt]`. `--`
  conventionally tells a CLI's own argument parser "everything after this is positional, not a
  flag" — useful when a prompt could start with `-`. It is also exactly what breaks Grok's `-p`;
  see [Grok](#grok).

## Claude Code

**Install:** native installer (macOS/Linux/WSL) `curl -fsSL https://claude.ai/install.sh | bash`,
or `brew install --cask claude-code`, or `npm install -g @anthropic-ai/claude-code`. Full options
(Windows, Linux package managers, version pinning): [Claude Code setup docs](https://code.claude.com/docs/en/setup).

**Log in:** run `claude` once interactively and follow the browser prompt, or set
`ANTHROPIC_API_KEY` to be prompted once to approve the key instead. The execution profile's
`home` (below) needs a completed login under that exact `HOME` before sessions can run there.

**Confirm non-interactively:**

```bash
claude auth status
```

Prints JSON by default (`isAuthenticated`, account/org info); pass `--text` for a human-readable
form. `claude doctor` is a broader install-health check and does not report login state on its
own.

**Preset** (`claude-print`):

```text
argv: ["claude", "-p", "--output-format", "json"]
appendPrompt: true
appendPromptSeparator: true
```

**Watch out for:** `-p`/`--print` is Claude's non-interactive mode; the prompt itself is supplied
as a positional argument or via stdin — the harness appends it for you, so a hand-authored Command
should not also hard-code one. Non-interactive `-p` runs still need a completed login; there is no
separate "headless" auth mode.

## Codex

**Install:** standalone installer (macOS/Linux) `curl -fsSL https://chatgpt.com/codex/install.sh | sh`.
npm and Homebrew installs also exist; see the
[Codex CLI docs](https://learn.chatgpt.com/docs/codex/cli) for the exact package/formula names
(not independently confirmed here).

**Log in:** `codex login` opens the "Sign in with ChatGPT" browser flow. For non-browser hosts,
pipe a credential instead: `printenv OPENAI_API_KEY | codex login --with-api-key`, or
`--with-access-token`, or `--device-auth` for a device-code flow.

**Confirm non-interactively:**

```bash
codex login status
```

**Preset** (`codex-exec`):

```text
argv: ["codex", "exec", "--json"]
appendPrompt: true
appendPromptSeparator: true
```

**Watch out for:** on Codex, `-p` means `--profile` (a config profile), not "prompt" — never
reach for `-p` on a Codex Command. `codex exec --json` prints newline-delimited JSON events; a
reply-only prompt that calls no tools exits with Codex's default `on-request` approval policy
and no extra sandbox/approval flags needed. Codex also enforces its own OS-level sandbox
(Seatbelt on macOS) around the commands it runs; that sandbox refuses a writable root whose path
has a symlink component, which is exactly why the daemon resolves the execution profile's `home`
through `realpathSync` before setting `HOME` (see
[Wiring a CLI into Auto Harness](#wiring-a-cli-into-auto-harness)).

## Cursor

**Install:** `curl https://cursor.com/install -fsS | bash` (macOS/Linux/WSL), or
`irm 'https://cursor.com/install?win32=true' | iex` on native Windows. Details:
[Cursor CLI installation docs](https://cursor.com/docs/cli/installation).

**Log in:** `cursor-agent login` opens a browser; set `NO_OPEN_BROWSER=1` to print a URL instead
of opening one. `--api-key` / `CURSOR_API_KEY` is also accepted.

**Confirm non-interactively:**

```bash
cursor-agent status --format json
```

(`status` and `whoami` are aliases of the same command.)

**Preset** (`cursor-print`):

```text
argv: ["cursor-agent", "--print", "--force", "--output-format", "json"]
appendPrompt: true
appendPromptSeparator: true
```

**Watch out for:** without `--force`/`-f`, `cursor-agent --print` still stops to ask for tool-call
approval — which hangs a non-interactive session waiting on input that will never arrive; the
preset already includes it. The preset also requests `--output-format json`, which lets the host
daemon record Cursor's structured token counts. Dispatch never adds an output flag to any
Command: every CLI's structured output has to be requested in the Command's own argv (see
`POST /commands` in [api.md](api.md)). Existing Cursor Commands created before this flag was added
must be updated explicitly; custom command argv remains operator-owned.

## Grok

**Install:** `curl -fsSL https://x.ai/cli/install.sh | bash` (macOS/Linux), or
`irm https://x.ai/cli/install.ps1 | iex` (Windows).

**Log in:** `grok login` opens xAI's OAuth flow (`auth.x.ai`) by default; `grok login --device-auth`
(alias `--device-code`) is the headless/remote path. `XAI_API_KEY` is a fallback used only when no
session token is active.

**Confirm non-interactively:** there is no dedicated status/whoami subcommand — confirmed against
`grok --help` (1.0.30) and xAI's own
[authentication guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md),
neither of which documents one. Confirm login by running a one-off prompt and checking for a
normal reply instead of an auth error:

```bash
grok -p "reply with exactly: OK" --output-format json
```

**Preset** (`grok-print`):

```text
argv: ["grok", "--always-approve", "--output-format", "json", "-p"]
appendPrompt: true
appendPromptSeparator: false
```

**Watch out for (the headline gotcha):** Grok's `-p`/`--single` takes the prompt as its own
option value. If a `--` separator is inserted before the appended prompt — the way the other
three presets do it — Grok reads `--` as the value of `-p` and the real prompt becomes a stray
extra argument, and Grok exits `2`. That is why `grok-print` is the only preset with
`appendPromptSeparator: false`, and it is not optional: creating the Grok Command through the API
instead of the web UI needs that field set explicitly. `POST /commands` defaults
`appendPromptSeparator` to `true` for any provider-owned command when the field is omitted (see
`POST /commands` in [api.md](api.md)) — omitting it for Grok silently reintroduces the exit-2
failure. `--always-approve` is Grok's equivalent of Cursor's `--force`: without it, a tool call
stops for interactive approval and the session hangs.

## Wiring a CLI into Auto Harness

Same four-step path for every CLI above: register it as a catalog Provider, attach a Provider
Account to a host, tell that host's daemon which local `HOME` to run it under, then verify.

### 1. Provider, Command, and Provider Account

**Web UI:** `/providers` → **Add provider**. Typing a `name` that matches a catalog key (`claude`,
`codex`, `cursor` or `cursor-agent`, `grok`) autofills the Command name, argv, and the two
append-prompt checkboxes from the tables above. Submitting creates the Provider, its Command, and
links `defaultCommandId` in one client-side flow
(`services/web/src/components/provider-create-form.tsx`).

**API:** `POST /providers` does **not** create a default Command — the autofill above is a
web-UI-only convenience, not server behavior (`services/api/src/local-routes-providers.ts`;
confirmed in [api.md](api.md#post-providers)). Scripting the same result needs the same calls the
UI makes, in order; `e2e/real-cli/real-cli-helpers.ts` is a working example:

```bash
# 1. Create the provider
PROVIDER=$(curl -fsS -X POST "$API/api/v1/providers" -H 'content-type: application/json' \
  -d '{"name":"claude"}')
PROVIDER_ID=$(node -pe 'JSON.parse(require("fs").readFileSync(0)).id' <<<"$PROVIDER")

# 2. Create its Command with the exact preset argv from above. For Grok, appendPromptSeparator
#    must be given explicitly as false here — see the Grok section above.
COMMAND=$(curl -fsS -X POST "$API/api/v1/commands" -H 'content-type: application/json' \
  -d '{"name":"claude-print","argv":["claude","-p","--output-format","json"],"appendPrompt":true,"appendPromptSeparator":true,"providerId":"'"$PROVIDER_ID"'"}')
COMMAND_ID=$(node -pe 'JSON.parse(require("fs").readFileSync(0)).id' <<<"$COMMAND")

# 3. Link it as the provider's default
curl -fsS -X PATCH "$API/api/v1/providers/$PROVIDER_ID" -H 'content-type: application/json' \
  -d '{"defaultCommandId":"'"$COMMAND_ID"'"}'

# 4. Create a Provider Account under it
curl -fsS -X POST "$API/api/v1/provider-accounts" -H 'content-type: application/json' \
  -d '{"providerId":"'"$PROVIDER_ID"'","label":"<account label>"}'
```

### 2. Attach the Provider Account to a host

Per the control-plane-does-everything invariant, this is done from the control plane, not the
host pane: `PUT /api/v1/hosts/:hostId/inventory` with `"providerAccounts": [{"providerAccountId":
"<id>"}]`, or the host detail page's **Repositories & Worktrees** tab. See [cli.md](cli.md#host-inventory-apiui).

### 3. The daemon-local execution profile

Attaching the account is not enough — the account also needs an entry in that host's
`HARNESS_EXECUTION_PROFILES` file before the daemon will ever run a session against it.

**File shape** (`services/host-daemon/src/execution-profiles.ts`):

```json
{
  "maxConcurrentAssignments": 4,
  "accounts": {
    "<providerAccountId>": {
      "home": "/absolute/path/to/a/dedicated/home/dir",
      "env": { "CODEX_HOME": "/absolute/path/to/a/dedicated/home/dir" }
    }
  }
}
```

**What the daemon does with it**, precisely:

- `loadExecutionProfiles()` reads this file, keyed by **Provider Account ID** (not Provider ID),
  once from the daemon's own process env (`HARNESS_EXECUTION_PROFILES`) — there is no live reload
  (`execution-profiles.ts:124-136`).
- Each entry becomes an `ExecutionProfile { providerAccountId, home, env }`
  (`execution-profiles.ts:14-18`). `home` must be an absolute path, and every account's `home` on
  a host must be a distinct directory — parsing throws if two accounts reuse one
  (`execution-profiles.ts:69-86`, `93-121`). `env` may add extra key/value pairs, but a key named
  `HOME`, `USERPROFILE`, or anything starting with `HARNESS_` makes the whole file fail to parse
  at daemon startup (`execution-profiles.ts:56-66`) — `applyExecutionProfile` (below) also skips
  those keys defensively, but by then a bad file has already crashed config load.
- At assignment time, `resolveExecutionProfile` looks up the session's target
  `providerAccountId` (`session-run-claimed.ts:410`). If the target has a `providerAccountId` and
  there is no ready profile for it, **that session** fails immediately with
  `errorMessage: "execution profile unavailable for <providerAccountId>"` and the CLI is never
  spawned (`session-run-claimed.ts:411-430`). This is a narrower, late-arriving race — see the
  failure mode below for the common case.
- When a profile does exist, `applyExecutionProfile()` builds the child process's environment
  by starting from the daemon's own scrubbed environment, layering in the profile's extra `env`
  entries (skipping any reserved key again), then forcing `env.HOME` and `env.USERPROFILE` to
  `realpathSync(profile.home)` — the resolved, symlink-free real path, not the literal configured
  string (`execution-profiles.ts:191-206`). This override applies **only to the assigned provider
  CLI's process**; git, setup scripts, and terminal hooks keep running under the daemon's own
  `HOME`.
- Registration advertises only a `ready: boolean` and an opaque SHA-256 fingerprint per account
  (home path + extra-env key names — never values, home paths, or credentials); see
  [host-daemon.md#config-loader](host-daemon.md#config-loader).

**Persisting it:** `pnpm local:daemon install-service` (or the systemd/LaunchAgent/scheduled-task
path in [deploy-host-daemon.md](deploy-host-daemon.md)) reads `HARNESS_EXECUTION_PROFILES` from
the environment and writes it into the persisted service env file alongside daemon identity, then
restarts the daemon so it picks up the change (no live reload otherwise). The path must be
absolute — `install-service` only checks that; it never confirms the daemon's own service account
can actually read the file, so a root-owned-but-unreadable path installs cleanly and then
crash-loops the daemon. Full hardening (who should own the file, why not `chown` it to the
service account, multi-account and single-operator symlink-farm patterns) is in
[deploy-host-daemon.md#provider-execution-profiles-required-for-provider-backed-dispatch](deploy-host-daemon.md#provider-execution-profiles-required-for-provider-backed-dispatch).

**The failure mode, plainly:** if no host advertises a ready profile for a session's target
Provider Account at all, the control plane's own placement check filters that account out
_before_ it ever sends a `session:assign` — so the daemon never even sees the session, let alone
refuses it, and there is no log line naming the cause on either side. The session just sits in
`queued` (its host keeps reporting healthy and Git-ready) until `queueExpiresAt` (default 8 days)
fails it with `errorCode: queue_expired`. In the meantime, `POST /scheduler/assign` returns a
normal `200 {"items": []}` on every poll — not an error, just nothing to assign. (The
`execution profile unavailable for <id>` message above is the _different_, narrower case where a
profile was advertised ready and then stopped being available before the assign message arrived —
don't go looking for that string to diagnose the common case.) Full diagnosis steps, including how
to check readiness without a live session, are in
[host-daemon.md#sessions-stay-queued-host-reports-healthy](host-daemon.md#sessions-stay-queued-host-reports-healthy).

### 4. Verify

**Locally**, the real-CLI Playwright specs drive this whole path end to end against a real
temporary git repo and a real in-process daemon:
[`e2e/real-cli/claude-print.spec.ts`](../e2e/real-cli/claude-print.spec.ts),
[`codex-exec.spec.ts`](../e2e/real-cli/codex-exec.spec.ts), and
[`cursor-print.spec.ts`](../e2e/real-cli/cursor-print.spec.ts), and
[`grok-print.spec.ts`](../e2e/real-cli/grok-print.spec.ts). Each spec skips itself when its CLI
isn't installed
(see `test:e2e:real-cli` in the root `package.json` and [e2e.md](e2e.md)). Run one CLI's spec:

```bash
HARNESS_REAL_CLI=1 pnpm test:e2e:real-cli -- e2e/real-cli/claude-print.spec.ts
```

**Against a deployed control plane**, the `auto-harness` operator CLI is gaining commands for
exactly this flow (landing in sibling PRs of this same stack — check `auto-harness --help` if a
command below isn't there yet; full flag reference is the CLI's own README):

```bash
auto-harness repo add --name <name> --url <url> [--default-branch <branch>]
auto-harness host repo add <hostId> <repositoryId> --path <path> [--worktree <id>=<path>]...
auto-harness session create --repo <repositoryId> --provider <id|name> --prompt <text> --wait
auto-harness host smoke <hostId> --repo-path <path> --provider <id|name> [--provider ...]
```

`host smoke` attaches a throwaway repository, runs one session per given provider that must echo
a marker, and always detaches and deletes the repository afterwards — exit `0` only if every
provider passes. `--repo-path` must be an existing git repository on the host with a clean `main`
checkout (and `.worktrees/` ignored).

## Usage limits

AI CLIs run out of plan/rate quota. The host daemon only ever reports a usage limit when a
**provider-aware adapter validates the CLI's own structured result** — free-form stdout/stderr is
never quota evidence, even when it contains an obvious phrase like "rate limit". Full policy and
the untrusted-vs-trusted-surface reasoning live in
[host-daemon.md#usage-limits-ai-vendor--cli-quotas](host-daemon.md#usage-limits-ai-vendor--cli-quotas);
this section is the operator-facing summary, keyed to the same four CLIs as the rest of this page.

**Detection only works when the argv the daemon actually spawns carries the preset's
structured-output flag** — `--output-format json` for claude/cursor/grok, `--json` for `codex exec`
(`hasStructuredOutputMode` in [`usage-adapter.ts`](../services/host-daemon/src/usage-adapter.ts)
checks `resolvedArgv` at execution time, whatever produced it). A Command whose stored `argv`
omits that flag (or a CLI upgrade that changes its non-JSON error text) never classifies a usage
limit and never cools down an account, regardless of exit code or CLI text — an ordinary `failed`
session, same as an unrecognized executable.

**How each CLI signals it** (adapters: [`usage-adapter.ts`](../services/host-daemon/src/usage-adapter.ts),
[`usage-adapter-codex.ts`](../services/host-daemon/src/usage-adapter-codex.ts),
[`usage-adapter-grok.ts`](../services/host-daemon/src/usage-adapter-grok.ts)):

- **Claude** — either a structured `error.type`/`code`/`status` of `rate_limit_error`,
  `usage_limit`, or `insufficient_quota`, **or** the CLI's own account-level plan quota
  (5h/weekly/model-specific caps), which is enforced client-side and carries no API error at all:
  the result envelope's `terminal_reason` field reads `"budget_exhausted"` while `subtype` can
  still say `"success"`.
- **Codex** — the sentence codex-cli's own error path writes verbatim, never model-authored, onto
  a top-level `{"type":"error"}.message` or `turn.failed.error.message`. Captured verbatim from a
  real out-of-usage account (2026-09-19, codex-cli 0.154.0): `"You've hit your usage limit. Visit
https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026
1:15 AM."` codex-cli has emitted roughly seven variants of this sentence with different trailing
  clauses — the adapter matches only the fixed lead-in (`you've hit your usage limit`), not a
  suffix.
- **Grok** — a top-level `{"type":"error","message":"…"}` envelope with no structured code. HTTP
  429 (plan/team rate limit) writes one of three "you've hit/reached…" sentences. A **separate**
  HTTP 402 path — the account's Grok Build credit balance, not a rate limit — writes a different
  sentence instead. Captured verbatim from a real out-of-usage account (2026-09-19, grok 1.0.30):
  `"Internal error: {\n  \"message\": \"API error (status 402 Payment Required): Grok Build usage
balance exhausted\", \"http_status\": 402\n}"`. Grok's CLI also re-prints that same failure a
  second time as plain text, whose embedded object happens to parse as JSON but has neither `type`
  nor `status` — the adapter only ever trusts a candidate carrying `type`/`status`/`response`/
  `text`, so that re-print can neither manufacture nor mask a usage-limit signal.
- **Gemini** (installed on some hosts but has no catalog preset — see the top of this page) —
  `error.status`/`error.code` of `RESOURCE_EXHAUSTED`, or that token as a whole word in
  `error.message`.
- **Cursor** — a structured result envelope carries `inputTokens`, `outputTokens`,
  `cacheReadTokens`, and `cacheWriteTokens`. The adapter records cache reads as cached input and
  leaves cache writes unmapped because the provider-neutral usage contract has no cache-write
  field. Confirmed against a real successful `cursor-agent --print --force --output-format json`
  capture (2026-09-10 build): `{"type":"result","subtype":"success","is_error":false,
"result":"hello world","usage":{"inputTokens":14615,"outputTokens":26,
"cacheReadTokens":4352,"cacheWriteTokens":0}}`. Usage-limit classification is derived only from
  Cursor's real structured exhausted-account envelope; it is never guessed from generic output.
  Regression fixtures for all of the above are pinned in
  [`usage-adapter-real-incident.test.ts`](../services/host-daemon/src/usage-adapter-real-incident.test.ts).

**What the control plane does** once the daemon reports `status: failed`, `errorCode:
"usage_limit"` (`session-transition-planner.ts`'s `planUsageLimit`): the assigned Provider Account
is paused globally — `usageLimitedUntil = now + usageLimitCooldownSeconds` (default 5 hours,
`GET/POST/PATCH /provider-accounts` — see [api.md](api.md#post-provider-accounts)) — the worktree
is released, and the session is **requeued** (never failed outright) with `errorCode:
"usage_limit"`, immediately trying the next eligible account or an explicit fallback target if one
exists. A providerless target has no account to cool down but still suppresses that target index
and falls through the same way.

**How an operator sees it:**

- The Provider Account's health shows a cooldown badge (`modules/ui`'s
  `provider-account-health.tsx`) while `usageLimitedUntil` is in the future; `GET
/provider-accounts/:id` also reports `lastUsageLimitedAt` (when it was last hit — this never
  clears itself) alongside it. `DELETE /provider-accounts/:id/usage-limit` clears an active
  cooldown early and re-triggers scheduling.
- A session that is still `queued` while requeuing shows `errorCode: "usage_limit"` — but this is
  transient, not a durable audit trail: the very next assignment (to another account, or a
  fallback) explicitly clears `errorCode` as part of picking up the new attempt
  (`control-plane-assign.ts`'s `delete session.errorCode`, and the durable path's `REMOVE …
errorCode`). A session that eventually **completes** via fallback will _not_ show
  `errorCode: "usage_limit"` afterwards, even though it hit one along the way — the durable proof
  at that point is the Provider Account's cooldown fields, plus the session's `resolvedRoute`
  having advanced past the original provider target to the fallback's `commandId`/`targetIndex`.
  A session that exhausts every account and every fallback before its queue deadline instead fails
  terminally with `errorCode: "queue_expired"` (`session-transition-planner.ts`'s
  `planQueueExpired`), which overwrites whatever `errorCode` the session carried while queued —
  so a `usage_limit` earlier in that session's life leaves no trace on the session record at all
  once it queue-expires; only the Provider Account's cooldown fields still show it happened.

**Running the opt-in regression spec:** [`e2e/real-cli/usage-limit.spec.ts`](../e2e/real-cli/usage-limit.spec.ts)
drives this whole path for real, for each of `claude`/`codex`/`grok` named in
`HARNESS_REAL_CLI_EXHAUSTED` (comma list) — never `cursor`, since there is nothing for it to
detect. Like the other `e2e/real-cli/*.spec.ts` specs it only registers under `HARNESS_REAL_CLI`
and skips any CLI `hasCli()` can't find; unlike them it drives the whole flow over the API only (no
browser), because the interesting assertions are on the Provider Account and session records, not
on-screen text. **Only opt a CLI into `HARNESS_REAL_CLI_EXHAUSTED` when that account is genuinely
out of usage right now** — the whole point is a real 402/429-shaped failure, and running it against
an account with quota left will just fail the test once the "provider" attempt succeeds instead of
failing over. In a single worktree:

```bash
HARNESS_REAL_CLI=1 HARNESS_REAL_CLI_EXHAUSTED=codex,grok pnpm test:e2e:real-cli -- e2e/real-cli/usage-limit.spec.ts
```

Across concurrent worktrees, use the worktree-scoped port block instead (see
[e2e.md#isolated-focused-control-runs](e2e.md#isolated-focused-control-runs)) so this run's
DynamoDB Local container and ports never collide with another worktree's:

```bash
HARNESS_REAL_CLI=1 HARNESS_REAL_CLI_EXHAUSTED=codex,grok \
  node scripts/worktree-e2e-env.mts --run -- --project=real-cli e2e/real-cli/usage-limit.spec.ts --workers=1
```
