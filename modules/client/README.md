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
