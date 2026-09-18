import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("host with no subcommand is a usage error, exit 2", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["host"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness host/);
});

test("host with an unknown subcommand is a usage error, exit 2", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["host", "frobnicate"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness host/);
});

test("host inventory with an unknown action is a usage error, exit 2", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["host", "inventory", "frobnicate"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness host inventory/);
});

test("host repo with an unknown action is a usage error, exit 2", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["host", "repo", "frobnicate"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness host repo/);
});
