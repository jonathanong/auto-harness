import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { BASE_ARGV, env, makeSmokeFetch } from "./host-smoke-fixture.js";

function conflict() {
  return Response.json(
    { error: { code: "CONFLICT", message: "still referenced" } },
    { status: 409 },
  );
}

test("a 409 dependency conflict on delete is retried, with an injected sleep, until it succeeds", async () => {
  let attempts = 0;
  const slept = [];
  const { fetch } = makeSmokeFetch({
    deleteRepository: () => {
      attempts += 1;
      if (attempts < 3) return conflict();
      return new Response(null, { status: 204 });
    },
  });
  const { io, stdout } = makeIo({ env, fetch });
  io.sleep = async (ms) => {
    slept.push(ms);
  };
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 0);
  assert.equal(attempts, 3);
  assert.equal(slept.length, 2);
  assert.match(stdout(), /teardown ok/);
});

test("delete retries are exhausted: exit 1, leftover repository id, exact cleanup commands printed", async () => {
  let attempts = 0;
  const { fetch } = makeSmokeFetch({
    deleteRepository: () => {
      attempts += 1;
      return conflict();
    },
  });
  const { io, stdout, stderr } = makeIo({ env, fetch });
  io.sleep = async () => {};
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.equal(attempts, 5); // DELETE_ATTEMPTS in host-smoke-teardown.js
  assert.match(stdout(), /teardown FAILED/);
  assert.match(stderr(), /leftover repository repo-1 — finish cleanup with:/);
  assert.match(stderr(), /auto-harness host repo rm host-1 repo-1/);
  assert.match(stderr(), /auto-harness repo rm repo-1/);
});

test("a non-retryable 4xx delete error is not retried", async () => {
  let attempts = 0;
  const { fetch } = makeSmokeFetch({
    deleteRepository: () => {
      attempts += 1;
      return Response.json(
        { error: { code: "VALIDATION_ERROR", message: "bad id" } },
        { status: 400 },
      );
    },
  });
  const { io, stderr } = makeIo({ env, fetch });
  io.sleep = async () => {};
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.equal(attempts, 1);
  assert.match(stderr(), /leftover repository repo-1/);
});

test("a plain 404 delete error, with no prior transient failure, is a real failure", async () => {
  let attempts = 0;
  const { fetch } = makeSmokeFetch({
    deleteRepository: () => {
      attempts += 1;
      return Response.json({ error: { code: "NOT_FOUND", message: "gone" } }, { status: 404 });
    },
  });
  const { io, stderr } = makeIo({ env, fetch });
  io.sleep = async () => {};
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.equal(attempts, 1);
  assert.match(stderr(), /leftover repository repo-1/);
});

test("a 5xx delete error is retried, with an injected sleep, until it succeeds", async () => {
  let attempts = 0;
  const slept = [];
  const { fetch } = makeSmokeFetch({
    deleteRepository: () => {
      attempts += 1;
      if (attempts < 3) {
        return Response.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 });
      }
      return new Response(null, { status: 204 });
    },
  });
  const { io, stdout } = makeIo({ env, fetch });
  io.sleep = async (ms) => {
    slept.push(ms);
  };
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 0);
  assert.equal(attempts, 3);
  assert.equal(slept.length, 2);
  assert.match(stdout(), /teardown ok/);
});

test("a network failure on delete is retried, and a later 404 is treated as success", async () => {
  let attempts = 0;
  const { fetch } = makeSmokeFetch({
    deleteRepository: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("socket hang up");
      return Response.json({ error: { code: "NOT_FOUND", message: "gone" } }, { status: 404 });
    },
  });
  const { io, stdout } = makeIo({ env, fetch });
  io.sleep = async () => {};
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 0);
  assert.equal(attempts, 2);
  assert.match(stdout(), /teardown ok/);
});

test("--json reports leftoverRepositoryId and teardown.ok: false on exhaustion", async () => {
  const { fetch } = makeSmokeFetch({ deleteRepository: () => conflict() });
  const { io, stdout } = makeIo({ env, fetch });
  io.sleep = async () => {};
  const exitCode = await main([...BASE_ARGV, "--json"], io);
  assert.equal(exitCode, 1);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.teardown.ok, false);
  assert.equal(parsed.teardown.leftoverRepositoryId, "repo-1");
  assert.equal(parsed.teardown.repositoryDeleted, false);
});

test(
  "a non-409 cancel failure during teardown leaves the session uncancelled: ok: false, " +
    "reported in uncancelledSessionIds and in the stderr guidance, repository still deleted",
  async () => {
    const { fetch, state } = makeSmokeFetch({
      getSession: () => {
        throw new Error("network down"); // provider fails with session_wait_failed
      },
      cancelSession: () =>
        Response.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
    });
    const { io, stdout, stderr } = makeIo({ env, fetch });
    const exitCode = await main([...BASE_ARGV, "--json"], io);
    assert.equal(exitCode, 1);
    assert.deepEqual(state.cancelledSessionIds, ["session-1"]); // teardown attempted the cancel
    const parsed = JSON.parse(stdout());
    assert.equal(parsed.teardown.ok, false);
    assert.deepEqual(parsed.teardown.uncancelledSessionIds, ["session-1"]);
    assert.equal(parsed.teardown.repositoryDeleted, true);
    assert.equal(parsed.teardown.leftoverRepositoryId, undefined); // repo itself is not leftover
    assert.match(stderr(), /leftover session session-1 — finish cleanup with:/);
    assert.match(stderr(), /auto-harness session cancel session-1/);
    assert.doesNotMatch(stderr(), /leftover repository/);
  },
);

test("a 409 on cancel during teardown is treated as already-terminal, not left uncancelled", async () => {
  const { fetch } = makeSmokeFetch({
    getSession: () => {
      throw new Error("network down");
    },
    cancelSession: () =>
      Response.json({ error: { code: "CONFLICT", message: "terminal" } }, { status: 409 }),
  });
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main([...BASE_ARGV, "--json"], io);
  assert.equal(exitCode, 1); // the provider itself still failed
  const parsed = JSON.parse(stdout());
  assert.deepEqual(parsed.teardown.uncancelledSessionIds, []);
  assert.equal(parsed.teardown.repositoryDeleted, true);
});

test("a detach failure alone (delete still succeeds) still fails teardown overall", async () => {
  let putAttempt = 0;
  const { fetch } = makeSmokeFetch({
    putInventory: (body, inventory) => {
      putAttempt += 1;
      if (putAttempt === 1)
        return Response.json({ ...body, version: (inventory.version ?? 0) + 1 }); // attach ok
      return Response.json(
        { error: { code: "CONFLICT", message: "inventory moved" } },
        { status: 409 },
      );
    },
  });
  const { io, stdout, stderr } = makeIo({ env, fetch });
  io.sleep = async () => {};
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.match(stdout(), /teardown FAILED/);
  assert.match(stderr(), /leftover repository repo-1/);
});

test("default real sleep/now are used when io does not inject them (timeout path still resolves)", async () => {
  const { fetch } = makeSmokeFetch({
    getSession: () => Response.json({ id: "session-1", status: "queued" }),
  });
  const { io, stdout } = makeIo({ env, fetch });
  // A tiny real timeout keeps this fast without needing a fake clock.
  const exitCode = await main([...BASE_ARGV, "--timeout", "1"], io);
  assert.equal(exitCode, 1);
  assert.match(stdout(), /teardown ok/);
});
