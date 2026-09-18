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
