import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { COOKIE_A, env as adminEnv, loginResponse } from "./admin-login-fixture.js";
import { makeIo } from "./cli-helpers.js";

// The same defect classes CodeRabbit found in #781, checked for in the code it never reviewed.
// makeIo's default fetch throws, so exit 2 (not 1) also proves nothing reached the network.

const keyEnv = { HARNESS_API_URL: "https://harness.test", HARNESS_API_KEY: "test-key" };

for (const argv of [
  ["repo", "rm", ".."],
  ["repo", "rm", "."],
  ["service-account", "rm", ".."],
]) {
  test(`${argv.join(" ")} is a usage error and sends nothing`, async () => {
    const { io, stderr } = makeIo({ env: keyEnv });
    assert.equal(await main(argv, io), 2);
    assert.match(stderr(), /must not be "\." or "\.\."/);
  });
}

test("an empty --key-file is refused before the account is created, so none is orphaned", async () => {
  const { io, stderr, writeFileExclusiveCalls } = makeIo({ env: keyEnv });
  const argv = ["service-account", "create", "--name", "ops", "--role", "agent", "--key-file="];
  assert.equal(await main(argv, io), 2);
  assert.match(stderr(), /--key-file was given an empty value/);
  assert.equal(writeFileExclusiveCalls.length, 0);
});

test('an empty --bound-host is refused rather than sent as boundHostId: ""', async () => {
  const { io, stderr } = makeIo({ env: keyEnv });
  const argv = ["service-account", "create", "--name", "ops", "--role", "agent"];
  assert.equal(await main([...argv, "--bound-host", " ", "--print-key"], io), 2);
  assert.match(stderr(), /--bound-host was given an empty value/);
});

test("an empty --admin-username is refused rather than silently logging in as admin", async () => {
  const { io, stderr } = makeIo({ env: adminEnv, stdinText: "hunter2\n" });
  assert.equal(await main(["whoami", "--admin-password-stdin", "--admin-username="], io), 2);
  assert.match(stderr(), /--admin-username was given an empty value/);
  assert.ok(!stderr().includes("hunter2"));
});

test("an empty --api-key-file still counts as an API key for the admin-identity ambiguity check", async () => {
  const { io, stderr } = makeIo({ env: adminEnv, stdinText: "hunter2\n" });
  assert.equal(await main(["whoami", "--admin-password-stdin", "--api-key-file="], io), 2);
  assert.match(stderr(), /cannot be combined with an API key/);
});

test("admin login fails on a stalled server instead of hanging, without echoing the password", async () => {
  const { io, stderr } = makeIo({
    env: adminEnv,
    stdinText: "hunter2\n",
    fetch: (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
  });
  io.timeoutSignal = () => {
    const controller = new AbortController();
    setImmediate(() =>
      controller.abort(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      ),
    );
    return controller.signal;
  };
  assert.equal(await main(["whoami", "--admin-password-stdin"], io), 1);
  assert.match(stderr(), /aborted due to timeout/);
  assert.ok(!stderr().includes("hunter2"));
});

test("admin login bounds its request with an AbortSignal by default", async () => {
  let loginSignal;
  const { io } = makeIo({
    env: adminEnv,
    stdinText: "hunter2\n",
    fetch: async (url, init) => {
      if (url.endsWith("/api/v1/auth/login")) {
        loginSignal = init.signal;
        return loginResponse(200, { cookies: [COOKIE_A] });
      }
      return Response.json({ id: "admin", kind: "admin", username: "admin", role: "admin" });
    },
  });
  assert.equal(await main(["whoami", "--admin-password-stdin"], io), 0);
  assert.ok(loginSignal instanceof AbortSignal);
});
