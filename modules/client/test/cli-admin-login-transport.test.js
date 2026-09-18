import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { COOKIE_A, loginResponse, refuseFetch } from "./admin-login-fixture.js";
import { makeIo } from "./cli-helpers.js";

// The admin password is a credential. Admin mode configures no API key, so the client's own
// `assertSecureTransport` never fires; `loginAsAdmin` has to apply the same rule itself.

/** An stdin that fails the test if anything reads it: a refused URL must not consume the
 * password at all, not merely decline to send it. */
function untouchableStdin() {
  return {
    [Symbol.asyncIterator]() {
      throw new Error("stdin must not be read");
    },
  };
}

async function refusedBeforeLogin(apiUrl, extraArgs = []) {
  const { io, stderr } = makeIo({ env: { HARNESS_API_URL: apiUrl } });
  io.stdin = untouchableStdin();
  io.fetch = refuseFetch;
  const exitCode = await main(["whoami", "--admin-password-stdin", ...extraArgs], io);
  return { exitCode, stderr: stderr() };
}

test("plain http to a non-loopback host is refused before stdin is read or anything is sent", async () => {
  const { exitCode, stderr } = await refusedBeforeLogin("http://harness.example.com");
  assert.equal(exitCode, 2);
  assert.match(stderr, /--admin-password-stdin requires an https API URL/);
});

test("--allow-insecure-http does not permit plain http to a non-loopback host", async () => {
  const { exitCode } = await refusedBeforeLogin("http://harness.example.com", [
    "--allow-insecure-http",
  ]);
  assert.equal(exitCode, 2);
});

test("plain http to loopback still needs --allow-insecure-http", async () => {
  const { exitCode } = await refusedBeforeLogin("http://127.0.0.1:7420");
  assert.equal(exitCode, 2);
});

test("plain http to loopback with --allow-insecure-http logs in", async () => {
  let loginUrl;
  const { io } = makeIo({
    env: { HARNESS_API_URL: "http://127.0.0.1:7420" },
    stdinText: "hunter2\n",
  });
  io.fetch = async (url) => {
    if (url.endsWith("/api/v1/auth/login")) {
      loginUrl = url;
      return loginResponse(200, { cookies: [COOKIE_A] });
    }
    return Response.json({ id: "admin", kind: "admin", username: "admin", role: "admin" });
  };
  const exitCode = await main(["whoami", "--admin-password-stdin", "--allow-insecure-http"], io);
  assert.equal(exitCode, 0);
  assert.equal(loginUrl, "http://127.0.0.1:7420/api/v1/auth/login");
});

test("doctor reports the refused transport as its auth failure and never logs in", async () => {
  const requested = [];
  const { io, stdout } = makeIo({ env: { HARNESS_API_URL: "http://harness.example.com" } });
  io.stdin = untouchableStdin();
  io.fetch = async (url) => {
    requested.push(url);
    return Response.json({ ok: true });
  };
  const exitCode = await main(["doctor", "--admin-password-stdin"], io);
  assert.equal(exitCode, 1);
  assert.match(stdout(), /fail auth: --admin-password-stdin requires an https API URL/);
  assert.ok(!requested.some((url) => url.endsWith("/auth/login")));
});
