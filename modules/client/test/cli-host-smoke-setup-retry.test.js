import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { BASE_ARGV, env, fakeClock, makeSmokeFetch } from "./host-smoke-fixture.js";

/** A `GET /sessions/<id>` response scripted by the numeric suffix of `sessionId` (each retry
 * creates a fresh session, "session-1", "session-2", ...) — every id below `passAt` fails with
 * worktree-manager.ts's own "Unknown repository" setup_failed shape; `passAt` and beyond
 * complete successfully. */
function unknownRepositoryUntil(passAt) {
  return (sessionId) => {
    const n = Number(sessionId.split("-")[1]);
    if (n < passAt) {
      return Response.json({
        id: sessionId,
        status: "failed",
        errorCode: "setup_failed",
        errorMessage: "Unknown repository: repo-1",
      });
    }
    return Response.json({ id: sessionId, status: "completed", exitCode: 0 });
  };
}

function trackedClock() {
  const { now, sleep } = fakeClock();
  const slept = [];
  return { now, slept, sleep: async (ms) => (slept.push(ms), sleep(ms)) };
}

test(
  "an 'Unknown repository' setup failure — the host racing its own inventory poll against " +
    "the repo host smoke just attached — is retried with backoff and eventually passes",
  async () => {
    const { fetch, state } = makeSmokeFetch({ getSession: unknownRepositoryUntil(2) });
    const { now, sleep, slept } = trackedClock();
    const { io, stdout, stderr } = makeIo({ env, fetch });
    io.now = now;
    io.sleep = sleep;
    const exitCode = await main(BASE_ARGV, io);
    assert.equal(exitCode, 0);
    assert.equal(state.sessions.size, 2);
    assert.deepEqual(slept, [2000]);
    assert.match(stdout(), /PASS {2}claude/);
    assert.match(
      stderr(),
      /host has not picked up the newly attached repository yet \(attempt 1\/5\)/,
    );
  },
);

test("exhausting every retry attempt fails the provider with the last errorMessage shown", async () => {
  const { fetch, state } = makeSmokeFetch({ getSession: unknownRepositoryUntil(Infinity) });
  const { now, sleep, slept } = trackedClock();
  const { io, stdout } = makeIo({ env, fetch });
  io.now = now;
  io.sleep = sleep;
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.equal(state.sessions.size, 5);
  assert.deepEqual(slept, [2000, 4000, 8000, 16000]);
  assert.match(stdout(), /FAIL {2}claude: Unknown repository: repo-1/);
});

test("a different setup_failed message is a real failure, never retried", async () => {
  const { fetch, state } = makeSmokeFetch({
    getSession: () =>
      Response.json({
        id: "session-1",
        status: "failed",
        errorCode: "setup_failed",
        errorMessage: "git checkout failed: no such ref",
      }),
  });
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.equal(state.sessions.size, 1);
  assert.match(stdout(), /FAIL {2}claude: git checkout failed: no such ref/);
});

test("retries stop once the overall --timeout budget is exhausted, not only at the attempt cap", async () => {
  const { fetch, state } = makeSmokeFetch({ getSession: unknownRepositoryUntil(Infinity) });
  const { now, sleep, slept } = trackedClock();
  const { io, stdout } = makeIo({ env, fetch });
  io.now = now;
  io.sleep = sleep;
  const exitCode = await main([...BASE_ARGV, "--timeout", "3"], io);
  assert.equal(exitCode, 1);
  assert.ok(
    state.sessions.size < 5,
    `expected early stop, created ${state.sessions.size} sessions`,
  );
  assert.ok(slept.every((ms) => ms <= 3000));
  assert.match(stdout(), /FAIL {2}claude: Unknown repository: repo-1/);
});
