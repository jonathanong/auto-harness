import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const TIMEOUT = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

/** A timeout signal the test fires itself, on the next macrotask — a real 30-second
 * `AbortSignal.timeout` cannot be fast-forwarded. */
function firingSoon() {
  const controller = new AbortController();
  setImmediate(() => controller.abort(TIMEOUT()));
  return controller.signal;
}

function rejectOnAbort(signal) {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("doctor fails reachability instead of hanging when the connection stalls", async () => {
  const { io, stdout } = makeIo({
    env: { HARNESS_API_URL: "https://harness.test" },
    fetch: (_url, init) => rejectOnAbort(init.signal),
  });
  io.timeoutSignal = firingSoon;
  const exitCode = await main(["doctor"], io);
  assert.equal(exitCode, 1);
  assert.match(stdout(), /fail reachability: GET \/health failed: .*aborted due to timeout/);
});

test("doctor reports a timeout during the body read as the timeout, not as a bad body", async () => {
  const { io, stdout } = makeIo({
    env: { HARNESS_API_URL: "https://harness.test" },
    fetch: async (_url, init) => ({ status: 200, json: () => rejectOnAbort(init.signal) }),
  });
  io.timeoutSignal = firingSoon;
  const exitCode = await main(["doctor"], io);
  assert.equal(exitCode, 1);
  const text = stdout();
  assert.match(text, /fail reachability: GET \/health failed: .*aborted due to timeout/);
  assert.ok(!text.includes('did not return {"ok":true}'));
});

test("doctor bounds the real reachability request with an AbortSignal by default", async () => {
  let signal;
  const { io } = makeIo({
    env: { HARNESS_API_URL: "https://harness.test" },
    fetch: async (_url, init) => {
      signal = init?.signal;
      return Response.json({ ok: true });
    },
  });
  const exitCode = await main(["doctor"], io);
  assert.equal(exitCode, 0);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

// makeIo's default fetch throws, so exit 2 (not 1) also proves no request was made.
test("an empty --api-url is a config error, not a fallback to HARNESS_API_URL", async () => {
  const { io, stderr } = makeIo({
    env: { HARNESS_API_URL: "https://harness.test", HARNESS_API_KEY: "env-key" },
  });
  assert.equal(await main(["whoami", "--api-url="], io), 2);
  assert.match(stderr(), /--api-url was given an empty value/);
});

test("an empty --api-key-file does not silently authenticate as HARNESS_API_KEY", async () => {
  for (const argv of [["--api-key-file="], ["--api-key-file", "   "]]) {
    const { io, stderr } = makeIo({
      env: { HARNESS_API_URL: "https://harness.test", HARNESS_API_KEY: "env-principal-key" },
    });
    assert.equal(await main(["whoami", ...argv], io), 2, argv.join(" "));
    assert.match(stderr(), /--api-key-file was given an empty value/);
    assert.ok(!stderr().includes("env-principal-key"));
  }
});
