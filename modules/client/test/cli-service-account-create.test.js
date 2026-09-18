import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { createHandler, env, refuseFetch, THE_KEY } from "./service-account-create-fixture.js";

test("neither --key-file nor --print-key is a usage error, no request made", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main(
    ["service-account", "create", "--name", "ci", "--role", "operator"],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /exactly one of --key-file or --print-key/);
});

test("both --key-file and --print-key is a usage error, no request made", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main(
    [
      "service-account",
      "create",
      "--name",
      "ci",
      "--role",
      "operator",
      "--key-file",
      "/key.txt",
      "--print-key",
    ],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /exactly one of --key-file or --print-key/);
});

test("--key-file to an existing path is a usage error before any request", async () => {
  const { io, stderr } = makeIo({
    env,
    files: { "/key.txt": "already here" },
    fetch: refuseFetch,
  });
  const exitCode = await main(
    ["service-account", "create", "--name", "ci", "--role", "operator", "--key-file", "/key.txt"],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /already exists/);
});

test("--key-file writes the key with 0600 semantics via the injected fs; never on stdout/stderr", async () => {
  const capture = {};
  const { io, stdout, stderr, writeFileExclusiveCalls } = makeIo({
    env,
    fetch: createHandler(capture),
  });
  const exitCode = await main(
    ["service-account", "create", "--name", "ci", "--role", "operator", "--key-file", "/key.txt"],
    io,
  );
  assert.equal(exitCode, 0);
  assert.equal(writeFileExclusiveCalls.length, 1);
  assert.equal(writeFileExclusiveCalls[0].path, "/key.txt");
  assert.match(writeFileExclusiveCalls[0].data, new RegExp(THE_KEY));
  assert.deepEqual(writeFileExclusiveCalls[0].options, { mode: 0o600 });
  assert.match(stdout(), /svc-9/);
  assert.match(stdout(), /key written to \/key\.txt/);
  assert.ok(!stdout().includes(THE_KEY));
  assert.ok(!stderr().includes(THE_KEY));
});

test("--key-file --json prints the allowlisted account, never the key", async () => {
  const { io, stdout } = makeIo({ env, fetch: createHandler() });
  const exitCode = await main(
    [
      "service-account",
      "create",
      "--name",
      "ci",
      "--role",
      "operator",
      "--key-file",
      "/key.txt",
      "--json",
    ],
    io,
  );
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.id, "svc-9");
  assert.ok(!("apiKey" in parsed));
  assert.ok(!stdout().includes(THE_KEY));
});

test("a file-write failure after creation names the created account id and says to delete it", async () => {
  const { io, stderr } = makeIo({ env, fetch: createHandler() });
  io.writeFileExclusive = async () => {
    throw new Error("disk full");
  };
  const exitCode = await main(
    ["service-account", "create", "--name", "ci", "--role", "operator", "--key-file", "/key.txt"],
    io,
  );
  assert.equal(exitCode, 1);
  const text = stderr();
  assert.match(text, /svc-9/);
  assert.match(text, /service-account rm svc-9/);
  assert.ok(!text.includes(THE_KEY));
});
