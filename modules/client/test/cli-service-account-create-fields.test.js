import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { createHandler, env, refuseFetch, THE_KEY } from "./service-account-create-fixture.js";

test("--print-key: stdout is exactly the key plus newline; summary is on stderr", async () => {
  const { io, stdout, stderr } = makeIo({ env, fetch: createHandler() });
  const exitCode = await main(
    ["service-account", "create", "--name", "ci", "--role", "operator", "--print-key"],
    io,
  );
  assert.equal(exitCode, 0);
  assert.equal(stdout(), `${THE_KEY}\n`);
  assert.match(stderr(), /svc-9/);
  assert.match(stderr(), /ci/);
  assert.match(stderr(), /operator/);
});

test("--repositories a,b maps to allowedRepositoryIds", async () => {
  const capture = {};
  const { io } = makeIo({ env, fetch: createHandler(capture) });
  const exitCode = await main(
    [
      "service-account",
      "create",
      "--name",
      "ci",
      "--role",
      "operator",
      "--repositories",
      "a,b",
      "--print-key",
    ],
    io,
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(capture.body.allowedRepositoryIds, ["a", "b"]);
});

test("--repositories with an empty entry is a usage error", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main(
    [
      "service-account",
      "create",
      "--name",
      "ci",
      "--role",
      "operator",
      "--repositories",
      "a,,b",
      "--print-key",
    ],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--repositories/);
});

test("--bound-host maps to boundHostId in the request body", async () => {
  const capture = {};
  const { io } = makeIo({ env, fetch: createHandler(capture) });
  await main(
    [
      "service-account",
      "create",
      "--name",
      "ci",
      "--role",
      "agent",
      "--bound-host",
      "host-1",
      "--print-key",
    ],
    io,
  );
  assert.equal(capture.body.boundHostId, "host-1");
});

test("--json and --print-key together is a usage error, no request made", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main(
    ["service-account", "create", "--name", "ci", "--role", "operator", "--print-key", "--json"],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--json and --print-key/);
});

test("missing --name or --role is a usage error", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main(
    ["service-account", "create", "--role", "operator", "--print-key"],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness service-account create/);
});

test("the server's 400 (e.g. an invalid role) surfaces as-is", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json(
        { error: { code: "VALIDATION_ERROR", message: "invalid role" } },
        { status: 400 },
      ),
  });
  const exitCode = await main(
    ["service-account", "create", "--name", "ci", "--role", "bogus", "--print-key"],
    io,
  );
  assert.equal(exitCode, 1);
  assert.match(stderr(), /invalid role/);
});
