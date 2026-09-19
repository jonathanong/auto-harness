import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { BASE_ARGV, env, makeSmokeFetch } from "./host-smoke-fixture.js";

test("a terminal setup failure is reported without creating a client-side retry session", async () => {
  const { fetch, state } = makeSmokeFetch({
    getSession: () =>
      Response.json({
        id: "session-1",
        status: "failed",
        errorCode: "setup_failed",
        errorMessage: "Unknown repository: repo-1",
      }),
  });
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 1);
  assert.equal(state.sessions.size, 1);
  assert.match(stdout(), /FAIL {2}claude: Unknown repository: repo-1/);
});
