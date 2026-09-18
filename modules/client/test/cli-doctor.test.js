import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const healthy = async () => Response.json({ ok: true }, { status: 200 });

test("doctor warns on a raw execute-api URL but still exits 0 with everything else healthy", async () => {
  const { io, stdout } = makeIo({
    env: { HARNESS_API_URL: "https://abc123.execute-api.us-east-1.amazonaws.com" },
    fetch: healthy,
  });
  const exitCode = await main(["doctor"], io);
  const text = stdout();
  assert.match(text, /warn url:.*CloudFront/);
  assert.equal(exitCode, 0);
});

test("doctor fails on a plain http:// URL without --allow-insecure-http", async () => {
  const { io, stdout } = makeIo({ env: { HARNESS_API_URL: "http://example.com" }, fetch: healthy });
  const exitCode = await main(["doctor"], io);
  assert.match(stdout(), /fail url:/);
  assert.equal(exitCode, 1);
});

test("doctor allows http:// with --allow-insecure-http", async () => {
  const { io, stdout } = makeIo({ env: { HARNESS_API_URL: "http://example.com" }, fetch: healthy });
  const exitCode = await main(["doctor", "--allow-insecure-http"], io);
  assert.match(stdout(), /ok url:/);
  assert.equal(exitCode, 0);
});

test("doctor reports reachability ok when /health returns {ok:true}", async () => {
  const { io, stdout } = makeIo({
    env: { HARNESS_API_URL: "https://harness.test" },
    fetch: healthy,
  });
  const exitCode = await main(["doctor"], io);
  assert.match(stdout(), /ok reachability: control plane is reachable/);
  assert.equal(exitCode, 0);
});

test("doctor fails reachability on a non-200 /health", async () => {
  const { io, stdout } = makeIo({
    env: { HARNESS_API_URL: "https://harness.test" },
    fetch: async () => new Response("nope", { status: 500 }),
  });
  const exitCode = await main(["doctor"], io);
  assert.match(stdout(), /fail reachability: GET \/health returned HTTP 500/);
  assert.equal(exitCode, 1);
});

test("doctor warns with no API key configured and runs only unauthenticated checks", async () => {
  const { io, stdout } = makeIo({
    env: { HARNESS_API_URL: "https://harness.test" },
    fetch: healthy,
  });
  const exitCode = await main(["doctor"], io);
  assert.match(stdout(), /warn auth: no API key configured; only unauthenticated checks ran/);
  assert.equal(exitCode, 0);
});

test("doctor reports auth ok with role and capabilities, never a hash field", async () => {
  const { io, stdout } = makeIo({
    env: { HARNESS_API_URL: "https://harness.test", HARNESS_API_KEY: "secret" },
    fetch: async (url) =>
      url.endsWith("/health")
        ? healthy()
        : Response.json({
            id: "svc-1",
            kind: "service-account",
            name: "ci",
            apiKeyHash: "should-not-print",
            role: "operator",
            capabilities: ["dispatch:sessions"],
          }),
  });
  const exitCode = await main(["doctor"], io);
  const text = stdout();
  assert.match(text, /ok auth: authenticated as role operator \(capabilities: dispatch:sessions\)/);
  assert.ok(!text.includes("should-not-print"));
  assert.equal(exitCode, 0);
});

test("doctor fails auth with a rejected API key (401)", async () => {
  const { io, stdout } = makeIo({
    env: { HARNESS_API_URL: "https://harness.test", HARNESS_API_KEY: "bad-key" },
    fetch: async (url) =>
      url.endsWith("/health")
        ? healthy()
        : Response.json(
            { error: { code: "UNAUTHORIZED", message: "invalid key" } },
            { status: 401 },
          ),
  });
  const exitCode = await main(["doctor"], io);
  assert.match(stdout(), /fail auth: API key rejected/);
  assert.equal(exitCode, 1);
});

test("doctor rejects unexpected positional arguments", async () => {
  const { io, stderr } = makeIo({ env: { HARNESS_API_URL: "https://harness.test" } });
  const exitCode = await main(["doctor", "extra"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /takes no arguments/);
});
