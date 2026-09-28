import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { BASE_ARGV, env, makeSmokeFetch } from "./host-smoke-fixture.js";

test("an unresolved smoke session is cancelled without altering its existing repository", async () => {
  const { fetch, calls, state } = makeSmokeFetch({
    getSession: () => {
      throw new Error("network down");
    },
  });
  const { io, stdout } = makeIo({ env, fetch });
  assert.equal(await main([...BASE_ARGV, "--json"], io), 1);
  assert.deepEqual(state.cancelledSessionIds, ["session-1"]);
  assert.equal(state.inventory.repositories.length, 1);
  assert.ok(!calls.some((call) => /^(PUT|DELETE) /.test(call)));
  const result = JSON.parse(stdout());
  assert.deepEqual(result.teardown.cancelledSessionIds, ["session-1"]);
  assert.deepEqual(result.teardown.uncancelledSessionIds, []);
});

test("a failed cancel reports the live session and preserves the repository", async () => {
  const { fetch, state } = makeSmokeFetch({
    getSession: () => {
      throw new Error("network down");
    },
    cancelSession: () =>
      Response.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
  });
  const { io, stdout, stderr } = makeIo({ env, fetch });
  assert.equal(await main([...BASE_ARGV, "--json"], io), 1);
  const result = JSON.parse(stdout());
  assert.deepEqual(result.teardown.uncancelledSessionIds, ["session-1"]);
  assert.equal(result.teardown.ok, false);
  assert.match(stderr(), /auto-harness session cancel session-1/);
  assert.doesNotMatch(stderr(), /host repo rm|repo rm/);
  assert.equal(state.inventory.repositories.length, 1);
});

test("a terminal-race 409 on cancel is not reported as a leftover session", async () => {
  const { fetch } = makeSmokeFetch({
    getSession: () => {
      throw new Error("network down");
    },
    cancelSession: () =>
      Response.json({ error: { code: "CONFLICT", message: "terminal" } }, { status: 409 }),
  });
  const { io, stdout } = makeIo({ env, fetch });
  assert.equal(await main([...BASE_ARGV, "--json"], io), 1);
  const result = JSON.parse(stdout());
  assert.equal(result.teardown.ok, true);
  assert.deepEqual(result.teardown.uncancelledSessionIds, []);
});
