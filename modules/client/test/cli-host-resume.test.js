import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("resume POSTs to /hosts/resume with hostId in the body, not the path", async () => {
  let request;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      request = { url, init };
      return Response.json({ hostId: "host-1", draining: false });
    },
  });
  const exitCode = await main(["host", "resume", "host-1"], io);
  assert.equal(exitCode, 0);
  assert.equal(request.url, "https://harness.test/api/v1/hosts/resume");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(request.init.body), { hostId: "host-1" });
  assert.match(stdout(), /resumed/);
  assert.match(stdout(), /not draining/);
});

test("resume --json prints the raw response", async () => {
  const response = { hostId: "host-1", draining: false };
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json(response) });
  const exitCode = await main(["host", "resume", "host-1", "--json"], io);
  assert.equal(exitCode, 0);
  assert.equal(stdout(), `${JSON.stringify(response, null, 2)}\n`);
});

test("resume surfaces a 409 with the normal error line and a retry hint", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json(
        { error: { code: "CONFLICT", message: "host connection changed while resuming" } },
        { status: 409 },
      ),
  });
  const exitCode = await main(["host", "resume", "host-1"], io);
  assert.equal(exitCode, 1);
  const text = stderr();
  assert.match(text, /error: host connection changed while resuming \(HTTP 409, CONFLICT\)/);
  assert.match(text, /retrying is safe/);
});

test("resume requires exactly one hostId argument", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["host", "resume"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness host resume/);
});
