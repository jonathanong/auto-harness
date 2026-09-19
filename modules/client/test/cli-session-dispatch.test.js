import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("session with no subcommand is a usage error, exit 2", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["session"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness session/);
});

test("session with an unknown subcommand is a usage error, exit 2", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["session", "frobnicate"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness session/);
});
