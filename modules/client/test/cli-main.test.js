import assert from "node:assert/strict";
import test from "node:test";

import { AutoHarnessRequestTimeoutError } from "../src/errors.js";
import { main } from "../src/cli/main.js";
import { reportError } from "../src/cli/report-error.js";
import { makeIo } from "./cli-helpers.js";

test("no arguments prints usage to stdout and exits 0", async () => {
  const { io, stdout, stderr } = makeIo({});
  const exitCode = await main([], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /Usage:/);
  assert.equal(stderr(), "");
});

for (const token of ["help", "--help", "-h"]) {
  test(`"${token}" prints usage to stdout and exits 0`, async () => {
    const { io, stdout } = makeIo({});
    const exitCode = await main([token], io);
    assert.equal(exitCode, 0);
    assert.match(stdout(), /Usage:/);
  });
}

test("an unknown command prints usage to stderr and exits 2", async () => {
  const { io, stdout, stderr } = makeIo({});
  const exitCode = await main(["frobnicate"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /Usage:/);
  assert.equal(stdout(), "");
});

test("--api-key is rejected everywhere with a usage error and never reaches fetch", async () => {
  const { io, stderr } = makeIo({
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["whoami", "--api-key", "super-secret"], io);
  assert.equal(exitCode, 2);
  assert.ok(!stderr().includes("super-secret"));
  assert.match(stderr(), /HARNESS_API_KEY/);
});

test("a request timeout error prints a clear message and exits 1", () => {
  const { io, stderr } = makeIo({});
  const exitCode = reportError(new AutoHarnessRequestTimeoutError(30_000), io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /error: Auto Harness request timed out after 30000ms/);
});

test("a global flag before the command name is hoisted after it", async () => {
  const { io, stdout } = makeIo({
    env: { HARNESS_API_URL: "https://harness.test" },
    fetch: async () => Response.json({ items: [] }),
  });
  const exitCode = await main(["--allow-insecure-http", "host", "list"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /no hosts/);
});

test("a global value flag before a two-word command carries its value through", async () => {
  const { io } = makeIo({
    fetch: async () => Response.json({ items: [] }),
  });
  const exitCode = await main(["--api-url", "https://harness.test", "service-account", "list"], io);
  assert.equal(exitCode, 0);
});

test("an unknown leading flag still falls through to the usage/exit-2 path", async () => {
  const { io, stderr } = makeIo({});
  const exitCode = await main(["--mystery", "whoami"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /Usage:/);
});
