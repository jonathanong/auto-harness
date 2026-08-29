import assert from "node:assert/strict";
import test from "node:test";

import {
  AutoHarnessClient,
  AutoHarnessDrainWaitTimeoutError,
  AutoHarnessRequestTimeoutError,
} from "../src/index.js";

test("resolves as soon as the drain reports a non-draining status", async () => {
  let calls = 0;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async () => {
      calls += 1;
      return Response.json({ operationId: "drain-1", status: "succeeded" });
    },
  });
  const result = await client.waitForSessionDrain("repo", "drain-1", {
    pollIntervalMs: 1,
    timeoutMs: 1_000,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(calls, 1);
});

test("resolves for a failed or released terminal status without throwing", async () => {
  for (const status of ["failed", "released", "unexpected"]) {
    const client = new AutoHarnessClient({
      baseUrl: "https://harness.test",
      fetch: async () => Response.json({ operationId: "drain-1", status }),
    });
    const result = await client.waitForSessionDrain("repo", "drain-1", {
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    assert.equal(result.status, status);
  }
});

test("polls again while the drain remains draining, until a terminal status arrives", async () => {
  let calls = 0;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async () => {
      calls += 1;
      return Response.json({
        operationId: "drain-1",
        status: calls < 3 ? "draining" : "succeeded",
      });
    },
  });
  const result = await client.waitForSessionDrain("repo", "drain-1", {
    pollIntervalMs: 1,
    timeoutMs: 1_000,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(calls, 3);
});

test("rejects with AutoHarnessDrainWaitTimeoutError once the overall timeoutMs budget elapses", async () => {
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async () => Response.json({ operationId: "drain-1", status: "draining" }),
  });
  await assert.rejects(
    client.waitForSessionDrain("repo", "drain-1", { pollIntervalMs: 5, timeoutMs: 20 }),
    (error) => {
      assert.ok(error instanceof AutoHarnessDrainWaitTimeoutError);
      assert.equal(error.code, "DRAIN_WAIT_TIMEOUT");
      assert.equal(error.repositoryId, "repo");
      assert.equal(error.operationId, "drain-1");
      assert.equal(error.timeoutMs, 20);
      return true;
    },
  );
});

test("clamps each poll request to the time remaining before timeoutMs, surfacing a drain timeout once the clamped request itself elapses at the deadline", async () => {
  let calls = 0;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    requestTimeoutMs: 30_000,
    fetch: async () => {
      calls += 1;
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    client.waitForSessionDrain("repo", "drain-1", { pollIntervalMs: 1, timeoutMs: 10 }),
    (error) => {
      assert.ok(error instanceof AutoHarnessDrainWaitTimeoutError);
      assert.equal(error.timeoutMs, 10);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("surfaces AutoHarnessRequestTimeoutError when an individual poll times out with budget still remaining", async () => {
  let calls = 0;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    requestTimeoutMs: 10,
    fetch: async () => {
      calls += 1;
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    client.waitForSessionDrain("repo", "drain-1", { pollIntervalMs: 1, timeoutMs: 10_000 }),
    (error) => {
      assert.ok(error instanceof AutoHarnessRequestTimeoutError);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("resolves a repositoryName before polling", async () => {
  const requests = [];
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async (url) => {
      requests.push(new URL(url).pathname);
      if (requests.at(-1) === "/api/v1/repositories") {
        return Response.json({ items: [{ id: "repo-1", name: "svc-a" }], nextCursor: null });
      }
      return Response.json({ operationId: "drain-1", status: "succeeded" });
    },
  });
  const result = await client.waitForSessionDrain({ repositoryName: "svc-a" }, "drain-1", {
    pollIntervalMs: 1,
    timeoutMs: 1_000,
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(requests, [
    "/api/v1/repositories",
    "/api/v1/repositories/repo-1/session-drains/drain-1",
  ]);
});

test("rejects invalid pollIntervalMs or timeoutMs options before making a request", async () => {
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async () => {
      throw new Error("must not be called");
    },
  });
  for (const options of [
    { pollIntervalMs: 0, timeoutMs: 1_000 },
    { pollIntervalMs: -1, timeoutMs: 1_000 },
    { pollIntervalMs: 1, timeoutMs: 0 },
    { pollIntervalMs: 1, timeoutMs: Infinity },
    {},
  ]) {
    await assert.rejects(
      client.waitForSessionDrain("repo", "drain-1", options),
      /must be a finite positive number/,
    );
  }
});
