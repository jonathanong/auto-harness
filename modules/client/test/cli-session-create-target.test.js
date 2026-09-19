import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { createHandler, env } from "./session-create-fixture.js";

const BASE = ["session", "create", "--repo", "repo-1", "--prompt", "do it"];

test("--provider matching a catalog id resolves without a name lookup", async () => {
  const capture = {};
  const calls = [];
  const { io } = makeIo({
    env,
    fetch: createHandler({ providers: [{ id: "prov-1", name: "codex" }], capture, calls }),
  });
  const exitCode = await main([...BASE, "--provider", "prov-1"], io);
  assert.equal(exitCode, 0);
  assert.deepEqual(capture.body.target, { providerId: "prov-1" });
  assert.deepEqual(
    calls.filter((call) => call.endsWith("/providers")),
    ["GET /api/v1/providers"],
  );
});

test("--provider with no matching id resolves by name via the library's own resolution", async () => {
  const capture = {};
  const { io } = makeIo({
    env,
    fetch: createHandler({ providers: [{ id: "prov-1", name: "codex" }], capture }),
  });
  const exitCode = await main([...BASE, "--provider", "codex"], io);
  assert.equal(exitCode, 0);
  assert.deepEqual(capture.body.target, { providerId: "prov-1" });
});

test("--command matching a catalog id resolves without a name lookup", async () => {
  const capture = {};
  const calls = [];
  const { io } = makeIo({
    env,
    fetch: createHandler({ commands: [{ id: "cmd-1", name: "claude-print" }], capture, calls }),
  });
  const exitCode = await main([...BASE, "--command", "cmd-1"], io);
  assert.equal(exitCode, 0);
  assert.deepEqual(capture.body.target, { commandId: "cmd-1" });
  assert.deepEqual(
    calls.filter((call) => call.endsWith("/commands")),
    ["GET /api/v1/commands"],
  );
});

test("--command with no matching id resolves by name via the library's own resolution", async () => {
  const capture = {};
  const { io } = makeIo({
    env,
    fetch: createHandler({ commands: [{ id: "cmd-1", name: "claude-print" }], capture }),
  });
  const exitCode = await main([...BASE, "--command", "claude-print"], io);
  assert.equal(exitCode, 0);
  assert.deepEqual(capture.body.target, { commandId: "cmd-1" });
});

test("an unresolvable --provider name surfaces the library's UNKNOWN_PROVIDER_NAME error", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: createHandler({ providers: [{ id: "prov-1", name: "codex" }] }),
  });
  const exitCode = await main([...BASE, "--provider", "nonexistent"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /no provider named "nonexistent"/);
  assert.match(stderr(), /UNKNOWN_PROVIDER_NAME/);
});
