# `auto-harness-client`

Dependency-free Node client for Auto Harness automation. Calls return after the control plane
accepts work; they do not wait for the agent session to finish.

```js
import { AutoHarnessClient } from "auto-harness-client";

const harness = new AutoHarnessClient({
  baseUrl: process.env.AUTO_HARNESS_URL,
  apiKey: process.env.AUTO_HARNESS_API_KEY,
  requestTimeoutMs: 30_000,
});

const session = await harness.createSession({
  repositoryId: "repo-1",
  prompt: "Review the latest changes",
  target: { providerId: "codex" },
  timeout: 1_800,
  concurrencyId: `github-${process.env.GITHUB_RUN_ID}`,
});
console.log(session.url);
```

`baseUrl` must be `https` whenever `apiKey` is set — the constructor throws otherwise. Pass
`allowInsecureHttp: true` to opt out, but only for a genuine loopback `baseUrl` (`127.0.0.0/8`,
`::1`, or `localhost`) — the constructor verifies this itself and throws for any other `http:`
`baseUrl` even when the flag is set. A private-network address (RFC1918) still crosses real network
hardware and does not qualify.

## Target by provider or command name

`target` and `fallbacks` accept a `providerId`/`commandId` as before, or a human-readable
`providerName`/`commandName`. `createSession()` resolves each name to an id via
`listProviders()`/`listCommands()` before sending the request — at most one list call per catalog,
regardless of how many refs need it, and none at all when every ref is already id-based.

```js
const session = await harness.createSession({
  repositoryId: "repo-1",
  prompt: "Review the latest changes",
  target: { providerName: "codex" },
  fallbacks: [{ commandName: "claude-print-plan" }],
  timeout: 1_800,
});
```

Provider and Command names are server-enforced unique slugs within their respective catalogs on
create/update, but those checks are read-then-write races rather than atomic constraints, and
legacy catalog rows are not rewritten.
Name resolution therefore still checks for more than one match rather than trusting uniqueness.
Either way, an unresolvable or ambiguous name throws `AutoHarnessError`
(`code === "UNKNOWN_PROVIDER_NAME"`, `"UNKNOWN_COMMAND_NAME"`, `"AMBIGUOUS_PROVIDER_NAME"`, or
`"AMBIGUOUS_COMMAND_NAME"`); the ambiguous-name message never includes the matched ids.

## Repository by name

`createSession()` and the principal session drain methods (`startSessionDrain()`,
`getSessionDrain()`, `releaseSessionDrain()`, `waitForSessionDrain()`) accept a `RepositoryRef` —
`{ repositoryId }` as before, or `{ repositoryName }` — wherever they take a `repositoryId`
parameter. `listSessions()`'s `repositoryId` filter and the repository administration methods
(`pauseRepository()`, `drainRepository()`, `activateRepository()`) remain id-only. Repositories are
not exposed as a single unpaginated catalog call, so resolving by name pages through
`listRepositories()` in full before matching. An unresolvable or ambiguous name throws
`AutoHarnessError` (`code === "UNKNOWN_REPOSITORY_NAME"` or `"AMBIGUOUS_REPOSITORY_NAME"`).

```js
const session = await harness.createSession({
  repositoryName: "voucha/filaments",
  prompt: "Review the latest changes",
  target: { providerId: "codex" },
  timeout: 1_800,
});
```

## Request deadlines

Every request has a deadline that includes receiving and consuming the JSON response body.
`requestTimeoutMs` defaults to `30_000` and must be a finite positive number no greater than
`300_000`. On expiry, the client throws `AutoHarnessRequestTimeoutError`, with
`code === "REQUEST_TIMEOUT"` and the configured `timeoutMs`. The client never retries requests
automatically; reuse an idempotency key where an ambiguous `POST` may safely be retried.

## Repository listing

Repository listings are bounded pages. Pass the returned cursor to load the next page:

```js
let page = await harness.listRepositories({ limit: 50 });
const repositories = [...page.items];
while (page.nextCursor) {
  page = await harness.listRepositories({ limit: 50, cursor: page.nextCursor });
  repositories.push(...page.items);
}
```

## Principal session drains

Cancels this principal's own queued and running sessions for one repository, then fences new
admission from that same principal until the fence is explicitly released. **Not** repository
drain or host drain — see
[Principal session drains](https://github.com/jonathanong/auto-harness/blob/main/docs/api.md#principal-session-drains)
for the full disambiguation and server-side guarantees. Use a stable idempotency key when retries
may be ambiguous, poll the durable operation, and release the fence explicitly only after
recording its terminal result.

```js
const drain = await harness.startSessionDrain("repo-1", {
  idempotencyKey: `deploy-${process.env.GITHUB_RUN_ID}`,
});

let progress = drain;
while (progress.status === "draining") {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  progress = await harness.getSessionDrain("repo-1", drain.operationId);
}
const failed = progress.status !== "succeeded";
if (failed) console.error(`Drain failed: ${progress.failureCode}`);
await harness.releaseSessionDrain("repo-1", drain.operationId);
if (failed) throw new Error(`Drain failed: ${progress.failureCode}`);
```

When create, clone, or resume loses to the fence, `AutoHarnessError` has `code === "DRAINING"`
plus the durable `operationId` and API-relative `statusUrl`; follow that operation rather than
reimplementing pagination or cancellation reconciliation.

`waitForSessionDrain(repositoryId, operationId, { pollIntervalMs, timeoutMs })` replaces the manual
poll loop above: it resolves `repositoryId`, then polls `getSessionDrain()` until a terminal status,
clamping every request — including each page fetched to resolve a `repositoryName` — to the time
remaining before `timeoutMs`. It resolves with the terminal `SessionDrain` for any status, including
`"failed"` and `"released"` — callers classify success themselves — and rejects with
`AutoHarnessDrainWaitTimeoutError` (`code === "DRAIN_WAIT_TIMEOUT"`) when the overall `timeoutMs`
budget elapses — including when a clamped request is the thing that times out at that same instant
— or with `AutoHarnessRequestTimeoutError` (`code === "REQUEST_TIMEOUT"`) if an individual request
times out while budget still remains.

```js
const progress = await harness.waitForSessionDrain("repo-1", drain.operationId, {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
});
const failed = progress.status !== "succeeded";
if (failed) console.error(`Drain failed: ${progress.failureCode}`);
await harness.releaseSessionDrain("repo-1", drain.operationId);
if (failed) throw new Error(`Drain failed: ${progress.failureCode}`);
```

## Resume a session

Resume re-runs a previously assigned session. It initially prefers the source host and its stored
native command/account route, using a native CLI resume where the provider supports it. If that
route becomes unavailable or its pin expires, the control plane clears the pin and falls back to a
fresh run through the normal target/fallback chain, which may land on another host. The source
session must have been assigned at least once, must not still be queued or running, and must not
be a scheduled session — sessions with `type: "scheduled"` are rejected with `409 CONFLICT`, since
only prompt sessions support resume.

```js
const resumed = await harness.resumeSession("session-1", { prompt: "Address the review comments" });
console.log(resumed.status);
```

Pass `target` (and, only alongside it, `fallbacks`) to **rebind** the resume onto a different
Command/Provider instead of continuing the source session's original route — the same
`providerId`/`commandId`/`providerName`/`commandName` shapes as `createSession()`, resolved to ids
the same way. This replaces the source session's whole target/fallback policy (a bare `fallbacks`
override with no `target` is rejected) and always resumes on a fresh assignment: there is no native
CLI resume onto a different Command, so it may also land on a different host.

```js
const resumed = await harness.resumeSession("session-1", {
  prompt: "Continue with the updated Command.",
  target: { commandName: "claude-print-auto" },
});
```

## List sessions

Session listings are bounded pages with the same cursor shape as repository listings, plus
filters for status, repository, host, origin, sort order, concurrency identity, and schedule
provenance:

```js
let page = await harness.listSessions({ repositoryId: "repo-1", status: "running", limit: 50 });
const sessions = [...page.items];
while (page.nextCursor) {
  page = await harness.listSessions({
    repositoryId: "repo-1",
    status: "running",
    limit: 50,
    cursor: page.nextCursor,
  });
  sessions.push(...page.items);
}
```

## `auto-harness-client/actions`

Dependency-free helpers for authoring a GitHub Action that dispatches Auto Harness sessions from
`INPUT_*` env vars: `requiredEnvironmentValue`, `parseInteger`, `parseRequiredLabels`,
`parseConcurrencyId`, `parseMetadata`, `parseHarnessApiOrigin`, `parseHarnessTarget`,
`parseHarnessFallbacks`, `TARGET_SPEC_KEYS`, `HarnessDispatchError`, and `writeOutputs` (for
`GITHUB_OUTPUT`/`GITHUB_STEP_SUMMARY`/`::notice` reporting). These parse the same env-var contract
that `auto-harness`'s own
[`actions/dispatch`](https://github.com/jonathanong/auto-harness/blob/main/actions/dispatch) action
uses, so a consuming
workflow's inline script and a bundled composite action stay in sync with the same validation.

The same module also covers session drain from a workflow: `isHarnessDrainOperation` (a type
guard for the `start-drain`/`get-drain`/`wait-for-drain`/`release-drain` operation vocabulary) and
`writeDrainOutputs` (writes `operation-id`/`status`/`queued-count`/`running-count`/
`cancelled-count`/`failure-code` to `GITHUB_OUTPUT` for a `SessionDrain`).

```js
import { parseHarnessTarget, requiredEnvironmentValue } from "auto-harness-client/actions";

const target = parseHarnessTarget(process.env.HARNESS_TARGET);
const apiKey = requiredEnvironmentValue(process.env, "HARNESS_API_KEY");
```

## CLI: `auto-harness`

This package also ships a small operator CLI, `auto-harness`, for scripting and debugging
against a control plane from a shell:

```sh
npx auto-harness-client whoami
# or, once installed:
auto-harness whoami
```

### Configuration

The CLI never touches your repository config or the host daemon's persisted env file — it only
reads what you pass it:

| Setting              | Flag                    | Environment variable(s)                       |
| -------------------- | ----------------------- | --------------------------------------------- |
| Base URL             | `--api-url <url>`       | `HARNESS_API_URL` (alias: `HARNESS_API_HTTP`) |
| API key              | —                       | `HARNESS_API_KEY`                             |
| API key, from a file | `--api-key-file <path>` | `HARNESS_API_KEY_FILE`                        |
| Allow plain HTTP     | `--allow-insecure-http` | —                                             |

A flag always wins over its environment variable. `HARNESS_API_URL`/`HARNESS_API_HTTP` are the
same two variables the host daemon itself already accepts, so operators typically have one set.
An `--api-key-file`/`HARNESS_API_KEY_FILE` value is read and trimmed of surrounding whitespace.

**There is no `--api-key` flag.** A key passed on the command line lands in `ps` output and shell
history for the life of the process and the life of the shell's history file. Use the
`HARNESS_API_KEY` environment variable, or point `--api-key-file` / `HARNESS_API_KEY_FILE` at a
file holding it; passing `--api-key` fails immediately with a usage error telling you so.

Exit codes: `0` success, `1` an API/HTTP failure (or a failed `doctor` check), `2` a usage or
configuration error.

#### Admin bootstrap: `--admin-password-stdin`

Every API key is minted by `service-account create`, which itself requires being authenticated —
so the very first maintainer or service-account key can only come from an admin, and admin exists
only as a username/password, not an API key. `--admin-password-stdin` (with `--admin-username
<name>`, default `admin`) logs in as that admin instead of using an API key: it reads the password
from stdin (one trailing newline stripped), `POST`s it once to `/auth/login`, and carries the
returned session cookie on every later request for the rest of the invocation. The password never
touches argv, shell history, or output, and the login response body — which carries the
principal — is deliberately never read or printed.

```sh
aws ssm get-parameter --name /auto-harness/admin-password --with-decryption \
  --query Parameter.Value --output text \
  | auto-harness --admin-password-stdin service-account create --name ci --role operator --print-key
```

It cannot be combined with an API key (`--api-key-file`, `HARNESS_API_KEY`, or
`HARNESS_API_KEY_FILE` all make the identity ambiguous) or with a command that also reads stdin
for its own input (`api --body-file -`, `host inventory set --file -`) — both are usage errors
(exit 2) before any request is made. A rejected password is `error: admin login failed (HTTP 401)`
(exit 1), never anything about the password itself. `whoami` and `doctor` work in this mode too,
reporting the admin identity instead of an API key's role.

### `auto-harness api <METHOD> <path>`

A generic escape hatch for any route the control plane exposes. Both `/hosts` and
`/api/v1/hosts` are accepted (a leading `/api/v1` is stripped). `--body` takes inline JSON;
`--body-file <path>` reads a file, and `--body-file -` reads stdin. A `204` or otherwise empty
response prints nothing; anything else is pretty-printed JSON on stdout.

```sh
auto-harness api GET /hosts
auto-harness api POST /repositories --body '{"name":"org/repo","url":"https://github.com/org/repo"}'
echo '{"prompt":"Review the latest changes"}' | auto-harness api POST /sessions --body-file -
```

### `auto-harness whoami [--json]`

`GET /auth/me`, printing only an allowlist of fields (`id`, `kind`, `username`, `name`, `role`,
`capabilities`, `boundHostId`, `allowedRepositoryIds`) — never `passwordHash`, `apiKeyHash`, or
anything else the API response happens to carry.

```sh
auto-harness whoami
auto-harness whoami --json
```

### `auto-harness doctor`

Runs a handful of independent checks and reports each as `ok`, `warn`, or `fail` with a one-line
reason, exiting `1` if any check `fail`s:

- **url** — `fail`s for a plain `http://` base URL unless `--allow-insecure-http` is set; `warn`s
  for a raw `*.execute-api.*.amazonaws.com` URL, which bypasses CloudFront (and the ingress token
  CloudFront injects), so requests against it will be rejected.
- **reachability** — `GET /health` (at the site root, not under `/api/v1`) expecting HTTP 200 and
  `{"ok":true}`.
- **auth** — if an API key is configured, `GET /auth/me`; `warn`s instead, without making the
  call, when no key is configured. A `401` reports "API key rejected".

```sh
auto-harness doctor
```

### `auto-harness host <subcommand>`

Operator commands for the host fleet. Every call goes through `client.request()` against the
same routes `auto-harness api` would hit — nothing here is a special path.

#### `auto-harness host list [--online | --offline] [--limit N] [--cursor C] [--all] [--json]`

`GET /hosts`, printing one line per host (`hostId`, `online`/`offline`, and `draining` when
true). `--online`/`--offline` filter server-side (mutually exclusive — passing both is a usage
error); `--limit`/`--cursor` page manually. If the page has a `nextCursor` and `--all` was not
passed, a final line prints it so you can continue.

`--all` follows `nextCursor` itself and prints every host across pages (or `{ items: [...all] }`
with `--json`). Per this repo's [list/history invariant](../../docs/plan.md#5-invariants), it
never collects pages without bound: it stops after 20 pages and warns on stderr if there was
still more, rather than silently truncating or looping forever.

```sh
auto-harness host list --online
auto-harness host list --all --json
```

#### `auto-harness host drain <hostId> [--json]`

`POST /hosts/drain` with `{"hostId": "<id>"}` in the JSON body — **the host id is never in the
path** (`POST /hosts/<id>/drain` does not exist). Prints how many sessions are still running and
their ids. A `409 CONFLICT` means the host's connection changed mid-request; the normal error is
printed, followed by a one-line hint that retrying is safe.

#### `auto-harness host resume <hostId> [--json]`

`POST /hosts/resume`, same body-param shape as `drain`. Idempotent — safe to run on a host that
is not currently draining, which returns 200 rather than an error.

#### `auto-harness host inventory get <hostId> [--json]`

`GET /hosts/<hostId>/inventory`. Human output shows the record's `version`, each attached
repository (`id`, `path`, worktree count), and the provider account count; `--json` prints the
raw record.

#### `auto-harness host inventory set <hostId> --file <path|->`

`PUT /hosts/<hostId>/inventory` from a JSON file (or `-` for stdin), sent **verbatim** — this is
an authoritative write that replaces the entire inventory record, not a merge. Two traps this
command guards against:

- **Omitting `version` silently disables optimistic concurrency**: the server falls back to
  whatever version is currently stored, so a concurrent edit can be overwritten with no error.
  This command refuses (exit 2) to send a document with no integer `version` field, and tells you
  to start from `auto-harness host inventory get <hostId> --json`.
- A version that has moved since you read it comes back as `409 CONFLICT` — re-read and reapply
  rather than retrying the same body.

Because the write replaces the whole record, omitting `providerAccounts` wipes the host's
provider routing — always build the new document from a fresh `inventory get --json`, editing
only what you mean to change.

#### `auto-harness host repo add <hostId> <repositoryId> --path <path> [--worktree <id>=<path>]... [--default-branch <branch>] [--dry-run] [--json]`

Attaches an already-registered repository (create it first with `auto-harness repo add`) to a
host's inventory — the counterpart of `host repo rm`. Same safe read-modify-write shape:

1. `GET /repositories/<repositoryId>` — a 404 fails with a clear message naming the id.
   `--default-branch` defaults to that repository's own `defaultBranch` when omitted.
2. `GET` the host's inventory. If this repository id is already attached, it fails (exit 1)
   naming the path it is attached at — this command never overwrites an existing attachment;
   remove it first with `host repo rm`.
3. `--dry-run` prints what would be attached and exits without writing.
4. Otherwise builds the new document as the record exactly as read, with the new entry appended
   to `repositories` and the read `version` kept — every other field, including
   `providerAccounts`, is preserved untouched.
5. On a `409` (someone else wrote first) it re-reads and re-applies, up to 3 attempts total. If
   the repository is now attached at the same path, that is treated as convergence (another
   writer already did what this call wanted) rather than an error; a different path fails,
   naming what is actually attached. Any other error status is not retried.
6. On success it prints what was attached and the version transition (e.g. `version 29 → 30`).

`--worktree <id>=<path>` is repeatable and adds one worktree entry per occurrence (split on the
first `=`, so a path containing `=` still parses); a malformed value or a repeated id is a usage
error (exit 2) before any request is made. Each becomes `{ id, name: id, path, labels: [] }` —
`name` mirrors `id`, and the worktree's own name/slug shape is validated server-side.

```sh
auto-harness host repo add host-1 repo-1 --path /repos/repo-1 --dry-run
auto-harness host repo add host-1 repo-1 --path /repos/repo-1 --worktree wt-1=/repos/repo-1/wt-1
```

#### `auto-harness host repo rm <hostId> <repositoryId> [--dry-run] [--json]`

Detaches one repository from a host. This exists because the only prior way to do it was to
hand-assemble a full `PUT` of the inventory record — easy to get wrong, especially for
`providerAccounts`, which a naive PUT can silently drop. This command does a safe
read-modify-write instead:

1. `GET` the inventory.
2. If no repository with that id is attached, it fails (exit 1) and lists the ids that _are_
   attached — nothing is written.
3. Builds the new document as the record exactly as read, with only that repository removed from
   `repositories` and the read `version` kept — every other field, including
   `providerAccounts`, is preserved untouched. (The control plane also re-adds any repository a
   scoped API key can't see before persisting, so this read-modify-write is safe even when the
   caller's key is scoped to a subset of repositories.)
4. `--dry-run` prints what would be removed — the repository's id, path, and the ids of its
   worktrees — and exits without writing.
5. On a `409` (someone else wrote first) it re-reads and re-applies, up to 3 attempts total, then
   fails saying the inventory kept changing. Any other error status is not retried.
6. On success it prints what was removed and the version transition (e.g. `version 29 → 30`).

**Removing a repository from the inventory also removes its worktrees** — they are a projection
of the repository, not independent records. Deleting the repository record itself (as opposed to
detaching it from this host's inventory) is a separate operation.

```sh
auto-harness host repo rm host-1 repo-1 --dry-run
auto-harness host repo rm host-1 repo-1
```

#### `auto-harness host smoke <hostId> --repo-path <path> --provider <id|name> [--provider <id|name>]... [--timeout <seconds>] [--json]`

Proves a host can run a real provider-routed session end to end, then cleans up after itself —
useful after standing up a new host, or after touching its execution profiles, without having to
open the control plane UI. It never needs to be run against production to be trusted: the CI
end-to-end suite (`e2e/control/cli-host-smoke.spec.ts`) exercises this exact command against a
real API, a real in-process host daemon, and a real (`echo`-backed) provider on every change.

**Preconditions this command cannot check itself:** `--repo-path` names a directory on the
**host**, not on whatever machine runs this CLI — they may be different machines entirely — so
this command never calls `existsSync` or otherwise inspects it locally. That path must already
be a git repository with a clean `main` checkout, and its `.gitignore` must exclude
`.worktrees/`, since this command attaches one worktree at `<repo-path>/.worktrees/<name>`,
named after the throwaway repository. Worktree names are unique across the whole fleet, so each
run uses a fresh name and concurrent smokes on different hosts never collide.

What it does, in order, always tearing down in a `finally` no matter which step failed:

1. **Create** a throwaway repository (`POST /repositories`) with a unique, valid (slug) name.
   Its `url` is a syntactically valid but inert `https://example.test/<name>.git` placeholder —
   the daemon dispatches sessions against the host-local path this same run attaches, never a
   repository's `url`, so nothing ever needs to resolve or dial it.
2. **Attach** it to `<hostId>`'s inventory via the same `attachRepository` read-modify-write
   `host repo add` uses, with one worktree named after the repository.
3. **For each `--provider`, in order** (accepts an id or a name, exactly like `session create`):
   create a session targeting it with the prompt `Reply with exactly: <MARKER>` (`MARKER` is
   random and unique per run), wait for it, then fetch one page of its logs. A provider `PASS`es
   only if the session `completed` with `exitCode` `0` **and** its stdout contains `MARKER`.
   - **The host racing its own inventory poll:** a host only learns about a newly attached
     repository through its own periodic poll — there is no push-on-write — so the very first
     session against the repository this command _just_ attached routinely loses that race in
     any real deployment, not only here: the host rejects it with a `setup_failed` session whose
     `errorMessage` is exactly `Unknown repository: <id>` (`services/host-daemon/src/
worktree-manager.ts`), which the control plane never retries on its own. This command
     recognizes that one exact, unambiguous shape and retries with it doubling backoff (up to 5
     attempts, capped at 16s between attempts) — bounded by the same `--timeout` deadline as
     everything else — before giving up and reporting it like any other failure. Any other
     `setup_failed` (a real checkout/setup problem) is never retried.
   - **Usage limits:** the control plane does not fail a session whose provider account hit its
     usage limit — it requeues the session (`errorCode: "usage_limit"`) and puts the account on
     cooldown instead (see `services/api/src/session-transition-planner.ts`'s
     `planUsageLimit()`). This command checks for that on every poll (not only a status change,
     since a requeued session's status can go right back to `"queued"` with no visible
     transition) and fails that one provider immediately with "provider account hit its usage
     limit" — it never sits out the rest of `--timeout` waiting for a cooldown to end.
   - **On timeout**, the session is cancelled (this command owns it) and the provider fails with
     a hint keyed off its last status: stuck in `queued` usually means no online host advertises
     a ready execution profile for that provider's account (`HARNESS_EXECUTION_PROFILES`), or
     nothing is running the scheduler.
4. **Teardown**, always: cancel any session this run created that isn't already terminal, detach
   the repository (only if it was actually attached), then `DELETE` it. The delete is
   dependency-guarded server-side, and the worktree/host-inventory projection it checks can lag
   the detach write teardown just made, so a `409` there is retried a few times with a short
   backoff before giving up. If teardown itself fails, this command exits `1` and prints the
   leftover repository id plus the exact `host repo rm`/`repo rm` commands to finish cleanup by
   hand.

Exit `0` only when every provider passed **and** teardown itself succeeded; `1` otherwise (a
malformed invocation is the usual usage-error exit `2`, before any of this runs). Progress
(`ok`/`FAIL` per step) goes to stderr as it happens; stdout stays a clean final summary — one
`PASS`/`FAIL` line per provider plus an overall line — or, with `--json`, the full structured
result (`hostId`, `repositoryId`, `providers[]`, `teardown`, `ok`).

```sh
auto-harness host smoke host-1 --repo-path /repos/repo-1 --provider claude
auto-harness host smoke host-1 --repo-path /repos/repo-1 --provider claude --provider codex --timeout 600
```

### `auto-harness repo <subcommand>`

Repository CRUD, straight against the same routes `auto-harness api` would hit.

#### `auto-harness repo add --name <name> --url <url> [--default-branch <branch>] [--json]`

`POST /repositories`. The response is the created repository record itself — there is no
`{ repository }` wrapper, matching the shape `GET /repositories/<id>` returns — so `--json`
prints it verbatim. Human output is one line, `<id>  <name>`, mirroring `repo list`'s per-line
format. `--default-branch` defaults server-side to `main` when omitted. The server also enforces
uniqueness and URL/name format; a rejected value comes back as the normal `error:` line (exit 1)
rather than a client-side re-check.

```sh
auto-harness repo add --name org/repo --url https://github.com/org/repo
```

#### `auto-harness repo list [--limit N] [--cursor C] [--all] [--json]`

`GET /repositories`, printing one line per repository (id, name, and status/url when present).
Paging works exactly like `host list`: `--limit`/`--cursor` page manually, and `--all` follows
`nextCursor` itself, capped at 20 pages with a stderr warning if more remain.

```sh
auto-harness repo list --all
```

#### `auto-harness repo rm <repositoryId> [--json]`

`DELETE /repositories/<id>`. The point of this command is that a refusal explains itself: a `409`
means other records still reference the repository, and rather than dumping that as raw JSON,
each blocking dependency gets the concrete next step to actually clear it:

| Dependency kind               | Next step                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `schedule`                    | `auto-harness api DELETE /schedules/<id>`                                            |
| `session` (live)              | wait for it, or `auto-harness api POST /sessions/<id>/cancel`                        |
| `session-drain`               | `auto-harness api POST /repositories/<repositoryId>/session-drains/<id>/release`     |
| `host-inventory`              | `auto-harness host repo rm <hostId> <repositoryId>`                                  |
| `worktree`                    | same as `host-inventory` — worktrees go with detaching the repository from that host |
| `integration: github-ingress` | remove this repository's binding from the GitHub ingress configuration               |
| `integration` (other)         | remove or retarget that integration                                                  |
| anything else                 | printed as `<kind> <id>`, so a new server-side kind still displays                   |

Exits `1` on a `409` (after printing the server's message and every hint). With `--json`, a `409`
prints `{ "deleted": false, "dependencies": [...], "hints": [...] }`; success prints
`{ "deleted": true, "id": "..." }`.

```sh
auto-harness repo rm repo-1
```

### `auto-harness service-account <subcommand>`

Service-account lifecycle. Every account's real permissions are its `role` and grants
(`boundHostId`/`allowedRepositoryIds`) — the CLI never invents a route for anything else.

#### `auto-harness service-account list [--limit N] [--cursor C] [--all] [--json]`

`GET /auth/service-accounts`, printing id, name, role, `boundHostId` (if set), and `createdAt`.
Items are already server-sanitized, but this still filters them through the same allowlist as
`whoami`/`doctor` as defense in depth — in **both** human and `--json` output, so a field outside
the allowlist can never leak through either mode. Paging matches `host list`/`repo list`.

#### `auto-harness service-account create --name <name> --role <role> [--bound-host <hostId>] [--repositories <id,id,...>] (--key-file <path> | --print-key) [--json]`

`POST /auth/service-accounts`. The response's API key is shown **exactly once** — the server
stores only a hash — so this command forces a deliberate choice about where that one-time value
goes:

- **`--key-file <path>`** writes the key to a new file, created with `O_CREAT | O_EXCL` and mode
  `0600` — it never overwrites an existing file (checked before the request is even made, and
  enforced atomically when the file is actually written). Only the account id and
  `key written to <path>` are printed; if the write fails _after_ the account was already
  created, the error names the account id and tells you to run `service-account rm` on it, since
  the key itself is unrecoverable at that point.
- **`--print-key`** writes _only_ the key to stdout, on its own line, so
  `KEY=$(auto-harness service-account create … --print-key)` works; the human-readable account
  summary goes to stderr instead. Combining this with `--json` is a usage error — the stdout
  contract would be ambiguous.

Exactly one of `--key-file`/`--print-key` is required; neither/both is a usage error (exit 2,
no request made). `--repositories a,b,c` maps to `allowedRepositoryIds`. The server validates
`--role` and any grants; an invalid one surfaces as its own `400`, unchanged.

```sh
auto-harness service-account create --name ci --role operator --key-file ./ci.key
KEY=$(auto-harness service-account create --name ci --role operator --print-key)
```

#### `auto-harness service-account rm <id> [--json]`

`DELETE /auth/service-accounts/<id>`. A `409` prints each blocking dependency generically, as
`<kind> <id>` — unlike `repo rm`, there is no per-kind hint here.

```sh
auto-harness service-account rm svc-1
```

### `auto-harness session <subcommand>`

Session lifecycle for the operator CLI. `--provider`/`--command` accept either a catalog id or a
name — see below.

#### `auto-harness session create --repo <repositoryId> (--provider <id|name> | --command <id|name>) --prompt <text> [--timeout <seconds>] [--ref <ref>] [--concurrency-id <id>] [--wait [--wait-timeout <seconds>]] [--json]`

`POST /sessions`. Exactly one of `--provider`/`--command` is required. Each accepts either a
catalog id or a name: the CLI lists the relevant catalog once and checks for an exact id match;
on a miss it sends the value as `providerName`/`commandName` and lets `createSession()`'s own
name resolution handle it — so an unresolvable or ambiguous name fails with the same
`AutoHarnessError` (`UNKNOWN_PROVIDER_NAME`, `AMBIGUOUS_PROVIDER_NAME`, ...) documented above,
never a separate "unknown id" error. `--timeout` defaults to `600` seconds (matching the
create-session form's own default) since the server requires it but sets no default itself; the
server's own ceiling (7 days) is enforced there, not duplicated here.

With `--wait`, polls the new session until it reaches a terminal status (`completed`, `failed`,
`cancelled`, or `timed_out`), printing each status change to **stderr** so stdout stays the final
session record. `--wait-timeout <seconds>` bounds the wait (default: the session's own
`--timeout`); on expiry the CLI prints that the session is still running and its id, then exits 1
— it never cancels the session. Exit 0 only when the session `completed` with `exitCode` exactly
`0`; every other terminal status, or a wait timeout, exits 1.

```sh
auto-harness session create --repo repo-1 --command claude-print --prompt "Review the diff" --wait
```

#### `auto-harness session get <sessionId> [--json]`

`GET /sessions/<id>`, via the library's `getSession()`. Prints one line: id, status, and — only
when present — `exitCode`, `errorCode`, `errorMessage` (session records use `errorCode`/
`errorMessage`, never a top-level `error`, and `completedAt`, never `finishedAt`). `--json` prints
the full record, including `result.summary` when the session set one.

```sh
auto-harness session get session-1
```

#### `auto-harness session logs <sessionId> [--limit N] [--cursor C] [--json]`

`GET /sessions/<id>/logs` — a bounded page, printed once; this command never loops over every
page (see `docs/plan.md` invariant 13). Unlike `repo list`/`host list`, the logs endpoint has no
`nextCursor`; its only continuation knob is `since`, a whole ISO-8601 timestamp (exclusive),
which this CLI exposes as `--cursor` for a pagination vocabulary consistent with the other list
commands. A full page (`items.length === limit`, default `1000`) prints a hint to pass the last
line's own timestamp as the next `--cursor` — which, because `since` excludes an entire
timestamp rather than one row, also skips any other record sharing that exact timestamp. This is
the bounded contract the endpoint offers today; there is no exact row cursor over REST.

```sh
auto-harness session logs session-1 --limit 200
```

#### `auto-harness session cancel <sessionId> [--json]`

`POST /sessions/<id>/cancel`, via the library's `cancelSession()`. Prints the same one-line
summary as `session get`.

```sh
auto-harness session cancel session-1
```
