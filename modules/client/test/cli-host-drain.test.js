import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("drain POSTs to /hosts/drain with hostId in the body, not the path", async () => {
  let request;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      request = { url, init };
      return Response.json({ hostId: "host-1", draining: true, runningSessionIds: ["s1", "s2"] });
    },
  });
  const exitCode = await main(["host", "drain", "host-1"], io);
  assert.equal(exitCode, 0);
  assert.equal(request.url, "https://harness.test/api/v1/hosts/drain");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(request.init.body), { hostId: "host-1" });
  const text = stdout();
  assert.match(text, /2 session/);
  assert.match(text, /s1/);
  assert.match(text, /s2/);
});

test("drain reports zero running sessions without listing any ids", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ hostId: "host-1", draining: true, runningSessionIds: [] }),
  });
  const exitCode = await main(["host", "drain", "host-1"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /0 session/);
});

test("drain --json prints the raw response", async () => {
  const response = { hostId: "host-1", draining: true, runningSessionIds: ["s1"] };
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json(response) });
  const exitCode = await main(["host", "drain", "host-1", "--json"], io);
  assert.equal(exitCode, 0);
  assert.equal(stdout(), `${JSON.stringify(response, null, 2)}\n`);
});

test("drain surfaces a 409 with the normal error line, then a retry hint", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json(
        { error: { code: "CONFLICT", message: "host connection changed while draining" } },
        { status: 409 },
      ),
  });
  const exitCode = await main(["host", "drain", "host-1"], io);
  assert.equal(exitCode, 1);
  const text = stderr();
  assert.match(text, /error: host connection changed while draining \(HTTP 409, CONFLICT\)/);
  assert.match(text, /retrying is safe/);
  assert.ok(text.indexOf("error:") < text.indexOf("retrying is safe"));
});

test("a non-409 error is not given a retry hint", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json({ error: { code: "NOT_FOUND", message: "host not found" } }, { status: 404 }),
  });
  const exitCode = await main(["host", "drain", "host-1"], io);
  assert.equal(exitCode, 1);
  assert.doesNotMatch(stderr(), /retrying is safe/);
});

test("drain requires exactly one hostId argument", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["host", "drain"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness host drain/);
});
