import assert from "node:assert/strict";
import test from "node:test";

import { AutoHarnessClient, AutoHarnessError } from "../src/index.js";

test("creates sessions with normalized URLs and bearer authentication", async () => {
  let request;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test/api/v1/",
    apiKey: "secret",
    fetch: async (url, init) => {
      request = { url, init };
      return Response.json({ id: "session", created: true });
    },
  });
  await assert.doesNotReject(
    client.createSession({
      repositoryId: "repo",
      prompt: "review",
      target: { providerId: "codex" },
    }),
  );
  assert.equal(request.url, "https://harness.test/api/v1/sessions");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.equal(request.init.headers["content-type"], "application/json");
});

test("maps stable API errors and retry metadata", async () => {
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async () =>
      Response.json(
        { error: { code: "RATE_LIMITED", message: "slow down" } },
        { status: 429, headers: { "retry-after": "5" } },
      ),
  });
  await assert.rejects(client.listRepositories(), (error) => {
    assert.ok(error instanceof AutoHarnessError);
    assert.equal(error.message, "slow down");
    assert.equal(error.status, 429);
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.retryAfter, "5");
    return true;
  });
});

test("encodes repository and session identifiers", async () => {
  const requests = [];
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async (url, init) => {
      requests.push([url, init?.method]);
      return Response.json({});
    },
  });
  await client.getSession("session/one");
  await client.cancelSession("session/two");
  await client.pauseRepository("repo/one");
  await client.drainRepository("repo/two");
  await client.activateRepository("repo/three");
  assert.deepEqual(requests, [
    ["https://harness.test/api/v1/sessions/session%2Fone", undefined],
    ["https://harness.test/api/v1/sessions/session%2Ftwo/cancel", "POST"],
    ["https://harness.test/api/v1/repositories/repo%2Fone/pause", "POST"],
    ["https://harness.test/api/v1/repositories/repo%2Ftwo/drain", "POST"],
    ["https://harness.test/api/v1/repositories/repo%2Fthree/activate", "POST"],
  ]);
});

test("requires a base URL and a fetch implementation", () => {
  assert.throws(() => new AutoHarnessClient({}), /baseUrl is required/);
  const prior = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    assert.throws(
      () => new AutoHarnessClient({ baseUrl: "https://harness.test" }),
      /fetch is required/,
    );
  } finally {
    globalThis.fetch = prior;
  }
});
