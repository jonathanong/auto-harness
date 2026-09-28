import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import {
  BASE_ARGV,
  env,
  makeSmokeFetch,
  REPOSITORY_ID,
  sessionStatuses,
} from "./host-smoke-fixture.js";

test("repository is absent or out of scope: fail before inventory or session access", async () => {
  const { fetch, calls } = makeSmokeFetch({
    getRepository: () =>
      Response.json(
        { error: { code: "NOT_FOUND", message: "resource not found" } },
        { status: 404 },
      ),
  });
  const { io, stdout, stderr } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, [`GET /api/v1/repositories/${REPOSITORY_ID}`]);
  assert.match(stderr(), /not found or outside this credential's scope/);
  assert.match(stdout(), /FAIL {2}setup: repository repo-1/);
  assert.match(stdout(), /teardown ok/);
});

test("repository not attached: fail without changing host inventory", async () => {
  const { fetch, calls } = makeSmokeFetch({
    getInventory: (inventory) => Response.json({ ...inventory, repositories: [] }),
  });
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.match(stdout(), /must already be attached/);
  assert.equal(calls.filter((call) => call === "GET /api/v1/hosts/host-1/inventory").length, 1);
  assert.ok(!calls.some((call) => call.startsWith("PUT ") || call.startsWith("POST ")));
});

test("a mismatched host path or missing worktree fails before a session is created", async () => {
  for (const repositories of [
    [{ id: REPOSITORY_ID, path: "/other", worktrees: [{ id: "wt" }] }],
    [{ id: REPOSITORY_ID, path: "/repos/x", worktrees: [] }],
  ]) {
    const { fetch, calls } = makeSmokeFetch({
      getInventory: (inventory) => Response.json({ ...inventory, repositories }),
    });
    const { io, stdout } = makeIo({ env, fetch });
    assert.equal(await main(BASE_ARGV, io), 1);
    assert.match(stdout(), /FAIL {2}setup:/);
    assert.ok(!calls.includes("POST /api/v1/sessions"));
    assert.ok(!calls.some((call) => call.startsWith("PUT ") || call.startsWith("DELETE ")));
  }
});

test("session create fails without changing the preconfigured attachment", async () => {
  const { fetch, calls, state } = makeSmokeFetch({
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
  assert.equal(calls.filter((call) => call === "GET /api/v1/hosts/host-1/inventory").length, 1);
  assert.equal(state.inventory.repositories[0].id, REPOSITORY_ID);
  assert.ok(!calls.some((call) => call.startsWith("PUT ") || call.startsWith("DELETE ")));
  assert.ok(!calls.some((call) => call.includes("/cancel"))); // no session was ever created
});

test("wait throws: only that provider fails and its session is cancelled", async () => {
  let getCalls = 0;
  const { fetch, calls, state } = makeSmokeFetch({
    getSession: () => {
      getCalls += 1;
      throw new Error("network down");
    },
  });
  const { io, stdout, stderr } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.equal(getCalls, 1);
  assert.equal(stdout().includes("FAIL  setup:"), false); // not a top-level setup failure
  assert.match(stderr(), /provider claude: session wait failed: network down/);
  assert.match(stdout(), /FAIL {2}claude: network down/);
  assert.deepEqual(state.cancelledSessionIds, ["session-1"]);
  assert.ok(!calls.some((call) => call.startsWith("DELETE /api/v1/repositories")));
});

test("wait throws mid-poll on one provider: the next --provider still runs and passes", async () => {
  let attempts = 0;
  const { fetch } = makeSmokeFetch({
    providers: [
      { id: "prov-1", name: "claude" },
      { id: "prov-2", name: "codex" },
    ],
    getSession: (sessionId, session) => {
      if (session?.target?.providerId === "prov-1") {
        attempts += 1;
        throw new Error("network down");
      }
      return Response.json({ id: sessionId, status: "completed", exitCode: 0 });
    },
  });
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main(
    [
      "host",
      "smoke",
      "host-1",
      "--repository-id",
      REPOSITORY_ID,
      "--repo-path",
      "/repos/x",
      "--provider",
      "claude",
      "--provider",
      "codex",
    ],
    io,
  );
  assert.equal(exitCode, 1);
  assert.equal(attempts, 1);
  assert.match(stdout(), /FAIL {2}claude: network down/);
  assert.match(stdout(), /PASS {2}codex/);
  assert.match(stdout(), /1\/2 providers passed/);
});

test("logs fetch fails after a completed session: nothing left to cancel", async () => {
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
