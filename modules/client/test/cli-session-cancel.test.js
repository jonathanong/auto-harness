import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("prints the one-line human summary and POSTs to /cancel", async () => {
  let request;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      request = { url, method: init?.method };
      return Response.json({ id: "session-1", status: "cancelled" });
    },
  });
  const exitCode = await main(["session", "cancel", "session-1"], io);
  assert.equal(exitCode, 0);
  assert.equal(stdout(), "session-1  cancelled\n");
  assert.equal(request.url, "https://harness.test/api/v1/sessions/session-1/cancel");
  assert.equal(request.method, "POST");
});

test("--json prints the full record", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ id: "session-1", status: "cancelled" }),
  });
  const exitCode = await main(["session", "cancel", "session-1", "--json"], io);
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout()), { id: "session-1", status: "cancelled" });
});

test("missing sessionId is a usage error", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["session", "cancel"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness session cancel/);
});

test("extra positional arguments are a usage error", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["session", "cancel", "session-1", "extra"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness session cancel/);
});

test("a sessionId of . or .. is rejected before any request", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["session", "cancel", "."], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /sessionId must not be "\."/);
});

test("a 409 (already terminal) surfaces as exit 1", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json(
        { error: { code: "CONFLICT", message: "session already terminal" } },
        { status: 409 },
      ),
  });
  const exitCode = await main(["session", "cancel", "session-1"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /session already terminal/);
});

test("a 404 surfaces as exit 1", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json(
        { error: { code: "NOT_FOUND", message: "session not found" } },
        { status: 404 },
      ),
  });
  const exitCode = await main(["session", "cancel", "session-1"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /session not found/);
});
