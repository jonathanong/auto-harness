import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { BASE_ARGV, env, makeSmokeFetch, sessionStatuses } from "./host-smoke-fixture.js";

test("repo create fails: exit 1, no attach/session/teardown calls, no crash", async () => {
  const { fetch, calls } = makeSmokeFetch({
    createRepository: () =>
      Response.json({ error: { code: "VALIDATION_ERROR", message: "bad name" } }, { status: 400 }),
  });
  const { io, stdout, stderr } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ["POST /api/v1/repositories"]);
  assert.match(stderr(), /FAIL {2}setup: bad name/);
  assert.match(stdout(), /FAIL {2}setup: bad name/);
  assert.match(stdout(), /teardown ok/); // nothing to tear down; must not crash
});

test("attach fails: repo already created is still deleted by teardown", async () => {
  const { fetch, calls } = makeSmokeFetch({
    putInventory: () =>
      Response.json(
        { error: { code: "VALIDATION_ERROR", message: "bad document" } },
        { status: 400 },
      ),
  });
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.match(stdout(), /FAIL {2}setup: bad document/);
  assert.ok(calls.includes("DELETE /api/v1/repositories/repo-1"));
  // Never attached, so detach must not even be attempted (it would just fail "not attached").
  assert.equal(calls.filter((call) => call === "GET /api/v1/hosts/host-1/inventory").length, 1);
});

test("session create fails: attach is still detached and the repo still deleted", async () => {
  const { fetch, calls } = makeSmokeFetch({
    createSession: () =>
      Response.json(
        { error: { code: "VALIDATION_ERROR", message: "no such provider" } },
        { status: 400 },
      ),
  });
  const { io, stdout, stderr } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /FAIL {2}provider claude: create session failed: no such provider/);
  assert.match(stdout(), /FAIL {2}claude: no such provider/);
  assert.equal(calls.filter((call) => call === "GET /api/v1/hosts/host-1/inventory").length, 2);
  assert.ok(calls.includes("DELETE /api/v1/repositories/repo-1"));
  assert.ok(!calls.some((call) => call.includes("/cancel"))); // no session was ever created
});

test("wait throws (network failure mid-poll): session is still cancelled by teardown's safety net", async () => {
  let getCalls = 0;
  const { fetch, calls, state } = makeSmokeFetch({
    getSession: () => {
      getCalls += 1;
      throw new Error("network down");
    },
  });
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.equal(getCalls, 1);
  assert.match(stdout(), /FAIL {2}setup: network down/);
  assert.deepEqual(state.cancelledSessionIds, ["session-1"]);
  assert.ok(calls.includes("DELETE /api/v1/repositories/repo-1"));
});

test("logs fetch fails after a completed session: nothing left to cancel, repo still deleted", async () => {
  const { fetch, state } = makeSmokeFetch({
    logsFor: () => {
      throw new Error("logs unavailable");
    },
  });
  const { io, stdout, stderr } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /FAIL {2}provider claude: fetching logs failed: logs unavailable/);
  assert.match(stdout(), /FAIL {2}claude: logs unavailable/);
  // The session was already terminal when logs failed, so it must not be cancelled again.
  assert.deepEqual(state.cancelledSessionIds, []);
});

test("completed but exitCode nonzero fails the provider without a marker check", async () => {
  const { fetch } = makeSmokeFetch({
    getSession: sessionStatuses([{ status: "completed", exitCode: 1 }]),
  });
  const { io, stdout, stderr } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /FAIL {2}provider claude: session completed \(exitCode=1\)/);
  assert.match(stdout(), /FAIL {2}claude: exitCode=1/);
});

test("completed with exitCode 0 but the marker is missing from stdout fails the provider", async () => {
  const { fetch } = makeSmokeFetch({ logsFor: () => Response.json({ items: [] }) });
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.match(stdout(), /FAIL {2}claude: completed but marker was not found in stdout/);
});

test("an unresolvable --provider name fails only that provider, not the whole run", async () => {
  const { fetch } = makeSmokeFetch({
    createSession: () =>
      Response.json(
        { error: { code: "UNKNOWN_PROVIDER_NAME", message: 'no provider named "claude"' } },
        { status: 400 },
      ),
  });
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.match(stdout(), /FAIL {2}claude: no provider named/);
});
