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

An automation principal can atomically stop admitting only its own sessions for one repository,
then wait for the control plane to cancel and settle that exact scope. This is not repository or
host drain. Use a stable idempotency key when retries may be ambiguous, poll the durable operation,
and release the fence explicitly only after recording its terminal result.

```js
const drain = await harness.startSessionDrain("repo-1", {
  idempotencyKey: `deploy-${process.env.GITHUB_RUN_ID}`,
});

let progress = drain;
while (progress.status === "draining") {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  progress = await harness.getSessionDrain("repo-1", drain.operationId);
}
if (progress.status !== "succeeded") throw new Error(`Drain failed: ${progress.failureCode}`);
await harness.releaseSessionDrain("repo-1", drain.operationId);
```

When create, clone, or resume loses to the fence, `AutoHarnessError` has `code === "DRAINING"`
plus the durable `operationId` and API-relative `statusUrl`; follow that operation rather than
reimplementing pagination or cancellation reconciliation.
