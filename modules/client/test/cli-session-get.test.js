import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("prints the one-line human summary", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ id: "session-1", status: "running" }),
  });
  const exitCode = await main(["session", "get", "session-1"], io);
  assert.equal(exitCode, 0);
  assert.equal(stdout(), "session-1  running\n");
});

test("includes exitCode, errorCode, and errorMessage only when present", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () =>
      Response.json({
        id: "session-1",
        status: "failed",
        exitCode: 1,
        errorCode: "setup_failed",
        errorMessage: "clone failed",
      }),
  });
  await main(["session", "get", "session-1"], io);
  assert.equal(
    stdout(),
    "session-1  failed  exitCode=1  errorCode=setup_failed  errorMessage=clone failed\n",
  );
});

test("--json prints the full record, including result.summary", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () =>
      Response.json({
        id: "session-1",
        status: "completed",
        exitCode: 0,
        completedAt: "2026-01-01T00:00:00.000Z",
        result: { summary: "done", summarySource: "agent" },
      }),
  });
  const exitCode = await main(["session", "get", "session-1", "--json"], io);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.completedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(parsed.result.summary, "done");
});

test("missing sessionId is a usage error", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["session", "get"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness session get/);
});

test("extra positional arguments are a usage error", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["session", "get", "session-1", "extra"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness session get/);
});

test("a sessionId of . or .. is rejected before any request", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["session", "get", ".."], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /sessionId must not be "\."/);
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
  const exitCode = await main(["session", "get", "session-1"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /session not found/);
});
