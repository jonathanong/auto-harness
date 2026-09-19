import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { createHandler, env } from "./session-create-fixture.js";

const BASE = ["session", "create", "--repo", "repo-1", "--prompt", "do it", "--command", "c1"];
const COMMANDS = [{ id: "c1" }];

async function runWait(getResponses, extraArgs = []) {
  const { io, stdout, stderr } = makeIo({
    env,
    fetch: createHandler({ commands: COMMANDS, getResponses }),
  });
  const exitCode = await main([...BASE, "--wait", ...extraArgs], io);
  return { exitCode, stdout: stdout(), stderr: stderr() };
}

test("completed with exitCode 0 exits 0", async () => {
  const { exitCode, stdout } = await runWait([
    { id: "session-1", status: "completed", exitCode: 0 },
  ]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /session-1\s+completed\s+exitCode=0/);
});

test("completed with a nonzero exitCode exits 1", async () => {
  const { exitCode } = await runWait([{ id: "session-1", status: "completed", exitCode: 1 }]);
  assert.equal(exitCode, 1);
});

test("completed with a null exitCode exits 1 (not the same as exitCode 0)", async () => {
  const { exitCode } = await runWait([{ id: "session-1", status: "completed", exitCode: null }]);
  assert.equal(exitCode, 1);
});

for (const status of ["failed", "cancelled", "timed_out"]) {
  test(`terminal status "${status}" exits 1`, async () => {
    const { exitCode } = await runWait([
      { id: "session-1", status, errorCode: "setup_failed", errorMessage: "boom" },
    ]);
    assert.equal(exitCode, 1);
  });
}

test("a status change is printed to stderr; stdout holds only the final result", async () => {
  const { stdout, stderr } = await runWait([{ id: "session-1", status: "completed", exitCode: 0 }]);
  assert.equal(stderr.trim(), "session session-1: completed");
  assert.match(stdout, /^session-1\s+completed\s+exitCode=0\n$/);
});

test("a wait timeout prints that the session is still running, exits 1, and never cancels it", async () => {
  const calls = [];
  const { io, stdout, stderr } = makeIo({
    env,
    fetch: createHandler({
      commands: COMMANDS,
      getResponses: [{ id: "session-1", status: "running" }],
      calls,
    }),
  });
  const exitCode = await main([...BASE, "--wait", "--wait-timeout", "0.02"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /session-1 is still running after 0\.02s; not cancelling it/);
  assert.match(stdout(), /session-1\s+running/);
  assert.ok(!calls.some((call) => call.includes("/cancel")));
});

test("--wait --json prints the final session record", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: createHandler({
      commands: COMMANDS,
      getResponses: [
        { id: "session-1", status: "completed", exitCode: 0, result: { summary: "ok" } },
      ],
    }),
  });
  const exitCode = await main([...BASE, "--wait", "--json"], io);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.result.summary, "ok");
});

test("--wait-timeout defaults to the session's own --timeout when not given", async () => {
  const { exitCode, stderr } = await runWait(
    [{ id: "session-1", status: "running" }],
    ["--timeout", "0.02"],
  );
  assert.equal(exitCode, 1);
  assert.match(stderr, /still running after 0\.02s/);
});
