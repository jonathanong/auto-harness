import assert from "node:assert/strict";
import test from "node:test";

import { AutoHarnessClient, AutoHarnessRequestTimeoutError } from "../src/index.js";

const successfulFetch = async () => Response.json({});

const assertRequestTimeout = (promise, timeoutMs) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof AutoHarnessRequestTimeoutError);
    assert.equal(error.code, "REQUEST_TIMEOUT");
    assert.equal(error.timeoutMs, timeoutMs);
    return true;
  });

test("uses a 30 second default request timeout and accepts the maximum", () => {
  assert.equal(
    new AutoHarnessClient({ baseUrl: "https://harness.test", fetch: successfulFetch })
      .requestTimeoutMs,
    30_000,
  );
  assert.equal(
    new AutoHarnessClient({
      baseUrl: "https://harness.test",
      fetch: successfulFetch,
      requestTimeoutMs: 300_000,
    }).requestTimeoutMs,
    300_000,
  );
});

test("rejects invalid request timeouts", () => {
  for (const requestTimeoutMs of [null, 0, -1, NaN, Infinity, 300_000.001, "30"]) {
    assert.throws(
      () =>
        new AutoHarnessClient({
          baseUrl: "https://harness.test",
          fetch: successfulFetch,
          requestTimeoutMs,
        }),
      /requestTimeoutMs must be a finite positive number no greater than 300000/,
    );
  }
});

test("bounds a fetch that ignores its abort signal without retrying", async () => {
  let calls = 0;
  const timeoutMs = 10;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    requestTimeoutMs: timeoutMs,
    fetch: async () => {
      calls += 1;
      return new Promise(() => {});
    },
  });

  await assertRequestTimeout(client.listRepositories(), timeoutMs);
  assert.equal(calls, 1);
});

test("maps an abort-aware fetch rejection to the request timeout error", async () => {
  let calls = 0;
  const timeoutMs = 10;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    requestTimeoutMs: timeoutMs,
    fetch: async (_url, init) => {
      calls += 1;
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("AbortError")), {
          once: true,
        });
      });
    },
  });

  await assertRequestTimeout(client.listRepositories(), timeoutMs);
  assert.equal(calls, 1);
});

test("bounds JSON body consumption", async () => {
  let calls = 0;
  const timeoutMs = 10;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    requestTimeoutMs: timeoutMs,
    fetch: async () => {
      calls += 1;
      return { status: 200, ok: true, json: async () => new Promise(() => {}) };
    },
  });

  await assertRequestTimeout(client.listRepositories(), timeoutMs);
  assert.equal(calls, 1);
});

test("applies the request deadline to every public request method", async () => {
  const timeoutMs = 10;
  const operations = [
    [
      "createSession",
      (client) =>
        client.createSession({
          repositoryId: "repo",
          prompt: "review",
          target: { providerId: "codex" },
        }),
    ],
    ["getSession", (client) => client.getSession("session")],
    ["cancelSession", (client) => client.cancelSession("session")],
    ["startSessionDrain", (client) => client.startSessionDrain("repo")],
    ["getSessionDrain", (client) => client.getSessionDrain("repo", "drain")],
    ["releaseSessionDrain", (client) => client.releaseSessionDrain("repo", "drain")],
    [
      "waitForSessionDrain",
      (client) =>
        client.waitForSessionDrain("repo", "drain", { pollIntervalMs: 1, timeoutMs: 10_000 }),
    ],
    ["listRepositories", (client) => client.listRepositories()],
    ["pauseRepository", (client) => client.pauseRepository("repo")],
    ["drainRepository", (client) => client.drainRepository("repo")],
    ["activateRepository", (client) => client.activateRepository("repo")],
  ];

  for (const [name, call] of operations) {
    let calls = 0;
    const client = new AutoHarnessClient({
      baseUrl: "https://harness.test",
      requestTimeoutMs: timeoutMs,
      fetch: async () => {
        calls += 1;
        return new Promise(() => {});
      },
    });

    await assertRequestTimeout(call(client), timeoutMs);
    assert.equal(calls, 1, name);
  }
});
