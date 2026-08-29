import assert from "node:assert/strict";
import test from "node:test";

import {
  AutoHarnessClient,
  AutoHarnessDrainWaitTimeoutError,
  AutoHarnessRequestTimeoutError,
} from "../src/index.js";
import { makeClient } from "./make-client.js";

const drainPath = "/api/v1/repositories/repo/session-drains/drain-1";

test("returns immediately when the drain is already terminal, with a single request", async () => {
  const { client, calls } = makeClient({
    [drainPath]: () =>
      Response.json({ operationId: "drain-1", repositoryId: "repo", status: "succeeded" }),
  });
  const result = await client.waitForSessionDrain("repo", "drain-1", {
    pollIntervalMs: 1_000,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(calls.length, 1);
});

test("polls until the drain leaves draining", async () => {
  let requests = 0;
  const { client } = makeClient({
    [drainPath]: () => {
      requests += 1;
      return Response.json({
        operationId: "drain-1",
        repositoryId: "repo",
        status: requests < 3 ? "draining" : "succeeded",
      });
    },
  });
  const result = await client.waitForSessionDrain("repo", "drain-1", {
    pollIntervalMs: 5,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(requests, 3);
});

test("throws AutoHarnessDrainWaitTimeoutError when the overall wait budget elapses", async () => {
  const { client } = makeClient({
    [drainPath]: () =>
      Response.json({ operationId: "drain-1", repositoryId: "repo", status: "draining" }),
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

test("caps each poll's own timeout to the remaining wait budget, and does not retry it", async () => {
  let calls = 0;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    requestTimeoutMs: 10_000,
    fetch: async () => {
      calls += 1;
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    client.waitForSessionDrain("repo", "drain-1", { pollIntervalMs: 1_000, timeoutMs: 20 }),
    (error) => {
      assert.ok(error instanceof AutoHarnessRequestTimeoutError);
      assert.ok(error.timeoutMs <= 20, `expected timeoutMs <= 20, got ${error.timeoutMs}`);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("rejects a missing or non-positive pollIntervalMs or timeoutMs", async () => {
  const { client } = makeClient({});
  for (const options of [
    undefined,
    {},
    { pollIntervalMs: 0, timeoutMs: 1_000 },
    { pollIntervalMs: 1_000, timeoutMs: 0 },
    { pollIntervalMs: -1, timeoutMs: 1_000 },
  ]) {
    await assert.rejects(client.waitForSessionDrain("repo", "drain-1", options), TypeError);
  }
});
