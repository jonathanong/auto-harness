import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import {
  BASE_ARGV,
  env,
  fakeClock,
  HOST_ID,
  makeSmokeFetch,
  REPO_PATH,
  sessionStatuses,
} from "./host-smoke-fixture.js";

test("usage_limit is detected on the very first poll, without waiting out --timeout", async () => {
  const { fetch, state } = makeSmokeFetch({
    getSession: () =>
      Response.json({ id: "session-1", status: "queued", errorCode: "usage_limit" }),
  });
  const { io, stdout } = makeIo({ env, fetch });
  // A real 300s default timeout with no fake clock would hang the test if usage_limit were not
  // caught on the first poll — this deliberately does not inject sleep/now.
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.deepEqual(state.cancelledSessionIds, ["session-1"]);
  assert.match(stdout(), /FAIL {2}claude: provider account hit its usage limit/);
});

test("usage_limit fires even when the status never changes from queued", async () => {
  // No status transition at all — onStatus alone would never notice; this only passes because
  // usage_limit is checked on every poll via the wrapped getSession, not on a status change.
  const { fetch, state } = makeSmokeFetch({
    getSession: () =>
      Response.json({ id: "session-1", status: "queued", errorCode: "usage_limit" }),
  });
  const { io } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.equal(state.cancelledSessionIds.length, 1);
});

test("a genuine timeout cancels the session and reports the queued-status hint", async () => {
  const { fetch, state } = makeSmokeFetch({ getSession: sessionStatuses([{ status: "queued" }]) });
  const { now, sleep } = fakeClock();
  const io0 = makeIo({ env, fetch });
  io0.io.now = now;
  io0.io.sleep = sleep;
  const exitCode = await main([...BASE_ARGV, "--timeout", "5"], io0.io);
  assert.equal(exitCode, 1);
  assert.deepEqual(state.cancelledSessionIds, ["session-1"]);
  assert.match(io0.stdout(), /execution profile/);
  assert.match(io0.stdout(), /scheduler/);
});

test("a timeout while running reports a different hint than queued", async () => {
  const { fetch } = makeSmokeFetch({ getSession: sessionStatuses([{ status: "running" }]) });
  const { now, sleep } = fakeClock();
  const { io, stdout } = makeIo({ env, fetch });
  io.now = now;
  io.sleep = sleep;
  const exitCode = await main([...BASE_ARGV, "--timeout", "5"], io);
  assert.equal(exitCode, 1);
  assert.match(stdout(), /still running when the timeout elapsed/);
});

test("a cancel-on-timeout failure other than 409 leaves the session for teardown to retry", async () => {
  let cancelAttempts = 0;
  const { fetch, state } = makeSmokeFetch({
    getSession: sessionStatuses([{ status: "queued" }]),
    cancelSession: () => {
      cancelAttempts += 1;
      if (cancelAttempts === 1) {
        return Response.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 });
      }
      return Response.json({ id: "session-1", status: "cancelled" });
    },
  });
  const { now, sleep } = fakeClock();
  const { io } = makeIo({ env, fetch });
  io.now = now;
  io.sleep = sleep;
  const exitCode = await main([...BASE_ARGV, "--timeout", "5"], io);
  assert.equal(exitCode, 1);
  assert.equal(cancelAttempts, 2); // once from the provider's own timeout path, once from teardown
  assert.deepEqual(state.cancelledSessionIds, ["session-1", "session-1"]);
});

test("a 409 on cancel-on-timeout is treated as already-terminal, not an error", async () => {
  const { fetch, state } = makeSmokeFetch({
    getSession: sessionStatuses([{ status: "queued" }]),
    cancelSession: () =>
      Response.json({ error: { code: "CONFLICT", message: "terminal" } }, { status: 409 }),
  });
  const { now, sleep } = fakeClock();
  const { io } = makeIo({ env, fetch });
  io.now = now;
  io.sleep = sleep;
  const exitCode = await main([...BASE_ARGV, "--timeout", "5"], io);
  assert.equal(exitCode, 1);
  assert.deepEqual(state.cancelledSessionIds, ["session-1"]); // not retried again by teardown
});

test("mixed results across providers: one PASS, one FAIL, exit 1, both reported", async () => {
  const { fetch } = makeSmokeFetch({
    providers: [
      { id: "prov-1", name: "claude" },
      { id: "prov-2", name: "codex" },
    ],
    getSession: (sessionId, session, callIndex) => {
      void callIndex;
      if (session?.target?.providerId === "prov-2") {
        return Response.json({ id: sessionId, status: "completed", exitCode: 1 });
      }
      return Response.json({ id: sessionId, status: "completed", exitCode: 0 });
    },
  });
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main(
    [
      "host",
      "smoke",
      HOST_ID,
      "--repo-path",
      REPO_PATH,
      "--provider",
      "claude",
      "--provider",
      "codex",
    ],
    io,
  );
  assert.equal(exitCode, 1);
  assert.match(stdout(), /PASS {2}claude/);
  assert.match(stdout(), /FAIL {2}codex/);
  assert.match(stdout(), /1\/2 providers passed/);
});

test("each marker is unique per run", async () => {
  const prompts = [];
  const { fetch } = makeSmokeFetch({
    createSession: (body) => {
      prompts.push(body.prompt);
      return Response.json({ id: `session-${prompts.length}`, status: "queued" });
    },
    getSession: (sessionId) => Response.json({ id: sessionId, status: "completed", exitCode: 0 }),
  });
  const { io: io1 } = makeIo({ env, fetch });
  await main(BASE_ARGV, io1);
  const { io: io2 } = makeIo({ env, fetch });
  await main(BASE_ARGV, io2);
  assert.equal(prompts.length, 2);
  assert.notEqual(prompts[0], prompts[1]);
  assert.match(prompts[0], /^Reply with exactly: AH_SMOKE_[0-9A-F]+$/);
});
