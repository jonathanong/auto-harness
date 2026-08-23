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

test("lists repository pages with a bounded limit and continuation cursor", async () => {
  const requests = [];
  const pages = [
    { items: [{ id: "repo-1" }], nextCursor: "cursor-1" },
    { items: [{ id: "repo-2" }], nextCursor: null },
  ];
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async (url, init) => {
      requests.push([url, init?.method]);
      return Response.json(pages.shift());
    },
  });

  const first = await client.listRepositories({ limit: 1 });
  const second = await client.listRepositories({ limit: 1, cursor: first.nextCursor });

  assert.deepEqual(first, { items: [{ id: "repo-1" }], nextCursor: "cursor-1" });
  assert.deepEqual(second, { items: [{ id: "repo-2" }], nextCursor: null });
  assert.deepEqual(requests, [
    ["https://harness.test/api/v1/repositories?limit=1", undefined],
    ["https://harness.test/api/v1/repositories?limit=1&cursor=cursor-1", undefined],
  ]);
});

test("preserves the no-argument repository listing URL", async () => {
  let request;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test/api/v1/",
    fetch: async (url) => {
      request = url;
      return Response.json({ items: [], nextCursor: null });
    },
  });

  await client.listRepositories();

  assert.equal(request, "https://harness.test/api/v1/repositories");
});

test("preserves DRAINING operation details for durable progress polling", async () => {
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "DRAINING",
            message: "principal session admission is draining",
            operationId: "drain-1",
            statusUrl: "/api/v1/repositories/repo/session-drains/drain-1",
          },
        },
        { status: 409 },
      ),
  });
  await assert.rejects(
    client.createSession({
      repositoryId: "repo",
      prompt: "review",
      target: { providerId: "codex" },
    }),
    (error) => {
      assert.ok(error instanceof AutoHarnessError);
      assert.equal(error.code, "DRAINING");
      assert.equal(error.operationId, "drain-1");
      assert.equal(error.statusUrl, "/api/v1/repositories/repo/session-drains/drain-1");
      return true;
    },
  );
});

test("starts, reads, and explicitly releases a principal session drain", async () => {
  const requests = [];
  const drain = {
    operationId: "drain-1",
    repositoryId: "repo/one",
    status: "succeeded",
    statusUrl: "/api/v1/repositories/repo%2Fone/session-drains/drain-1",
    requestedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    deadlineAt: "2026-01-01T00:15:00.000Z",
    queuedCount: 0,
    runningCount: 0,
    cancelledCount: 2,
  };
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async (url, init) => {
      requests.push([url, init?.method, init?.headers?.["idempotency-key"]]);
      return Response.json(drain);
    },
  });
  assert.deepEqual(
    await client.startSessionDrain("repo/one", { idempotencyKey: "release-42" }),
    drain,
  );
  assert.deepEqual(await client.getSessionDrain("repo/one", "drain-1"), drain);
  assert.deepEqual(await client.releaseSessionDrain("repo/one", "drain-1"), drain);
  assert.deepEqual(requests, [
    ["https://harness.test/api/v1/repositories/repo%2Fone/session-drains", "POST", "release-42"],
    [
      "https://harness.test/api/v1/repositories/repo%2Fone/session-drains/drain-1",
      undefined,
      undefined,
    ],
    [
      "https://harness.test/api/v1/repositories/repo%2Fone/session-drains/drain-1/release",
      "POST",
      undefined,
    ],
  ]);
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
