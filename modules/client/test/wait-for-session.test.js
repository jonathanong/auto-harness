import assert from "node:assert/strict";
import test from "node:test";

import { waitForSession } from "../src/cli/wait-for-session.js";

/** A fake `now`/`sleep` pair: `now()` returns the running virtual clock; `sleep(ms)` advances it
 * instantly instead of really waiting, so every test here resolves synchronously. */
function fakeClock(start = 0) {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

test("resolves immediately for an already-terminal session, even with a tiny timeout", async () => {
  let calls = 0;
  const client = { getSession: async () => (calls += 1) && { id: "s1", status: "completed" } };
  const { now, sleep } = fakeClock();
  const result = await waitForSession(client, "s1", { timeoutMs: 1, intervalMs: 1000, sleep, now });
  assert.equal(result.timedOut, false);
  assert.equal(result.session.status, "completed");
  assert.equal(calls, 1);
});

for (const status of ["completed", "failed", "cancelled", "timed_out"]) {
  test(`resolves for terminal status "${status}"`, async () => {
    const client = { getSession: async () => ({ id: "s1", status }) };
    const { now, sleep } = fakeClock();
    const result = await waitForSession(client, "s1", {
      timeoutMs: 1000,
      intervalMs: 10,
      sleep,
      now,
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.session.status, status);
  });
}

test("polls again while active, until a terminal status arrives", async () => {
  let calls = 0;
  const client = {
    getSession: async () => {
      calls += 1;
      return { id: "s1", status: calls < 3 ? "running" : "completed" };
    },
  };
  const { now, sleep } = fakeClock();
  const result = await waitForSession(client, "s1", {
    timeoutMs: 10_000,
    intervalMs: 5,
    sleep,
    now,
  });
  assert.equal(result.timedOut, false);
  assert.equal(calls, 3);
});

test("onStatus fires once per change, including the first observed status, never on a repeat", async () => {
  let calls = 0;
  const client = {
    getSession: async () => {
      calls += 1;
      if (calls === 1) return { id: "s1", status: "queued" };
      if (calls <= 3) return { id: "s1", status: "running" };
      return { id: "s1", status: "completed" };
    },
  };
  const { now, sleep } = fakeClock();
  const seen = [];
  await waitForSession(client, "s1", {
    timeoutMs: 10_000,
    intervalMs: 1,
    sleep,
    now,
    onStatus: (status) => seen.push(status),
  });
  assert.deepEqual(seen, ["queued", "running", "completed"]);
});

test("times out without throwing once the budget elapses, returning the last active session", async () => {
  const client = { getSession: async () => ({ id: "s1", status: "running" }) };
  const { now, sleep } = fakeClock();
  const result = await waitForSession(client, "s1", { timeoutMs: 10, intervalMs: 3, sleep, now });
  assert.equal(result.timedOut, true);
  assert.equal(result.session.status, "running");
});

test("clamps the sleep interval to the time remaining before the deadline", async () => {
  const client = { getSession: async () => ({ id: "s1", status: "running" }) };
  const { now, sleep } = fakeClock();
  const slept = [];
  const trackedSleep = async (ms) => {
    slept.push(ms);
    await sleep(ms);
  };
  await waitForSession(client, "s1", { timeoutMs: 10, intervalMs: 1000, sleep: trackedSleep, now });
  assert.ok(slept.length > 0);
  assert.ok(slept.every((ms) => ms <= 10));
});

test("propagates a real getSession rejection instead of swallowing it", async () => {
  const client = {
    getSession: async () => {
      throw new Error("network down");
    },
  };
  const { now, sleep } = fakeClock();
  await assert.rejects(
    waitForSession(client, "s1", { timeoutMs: 1000, intervalMs: 10, sleep, now }),
    /network down/,
  );
});

test("uses real setTimeout/Date.now by default when sleep/now are not injected", async () => {
  const client = { getSession: async () => ({ id: "s1", status: "completed" }) };
  const result = await waitForSession(client, "s1", { timeoutMs: 1000, intervalMs: 10 });
  assert.equal(result.timedOut, false);
});
