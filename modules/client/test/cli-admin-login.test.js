import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { COOKIE_A, COOKIE_B, env, loginResponse, refuseFetch } from "./admin-login-fixture.js";
import { makeIo } from "./cli-helpers.js";

test("login body carries the stdin password with one trailing newline stripped", async () => {
  let loginBody;
  const { io } = makeIo({ env, stdinText: "hunter2\n" });
  io.fetch = async (url, init) => {
    if (url.endsWith("/api/v1/auth/login")) {
      loginBody = JSON.parse(init.body);
      return loginResponse(200, { cookies: [COOKIE_A] });
    }
    return Response.json({ id: "admin", kind: "admin", username: "admin", role: "admin" });
  };
  const exitCode = await main(["whoami", "--admin-password-stdin"], io);
  assert.equal(exitCode, 0);
  assert.equal(loginBody.username, "admin");
  assert.equal(loginBody.password, "hunter2");
});

test("--admin-password-stdin before the command name is recognized the same way", async () => {
  let loginBody;
  const { io } = makeIo({ env, stdinText: "hunter2\n" });
  io.fetch = async (url, init) => {
    if (url.endsWith("/api/v1/auth/login")) {
      loginBody = JSON.parse(init.body);
      return loginResponse(200, { cookies: [COOKIE_A] });
    }
    return Response.json({ id: "admin", kind: "admin", username: "admin", role: "admin" });
  };
  const exitCode = await main(["--admin-password-stdin", "whoami"], io);
  assert.equal(exitCode, 0);
  assert.equal(loginBody.password, "hunter2");
});

test("--admin-password-stdin before a two-word command still reaches it", async () => {
  const { io } = makeIo({ env, stdinText: "hunter2\n" });
  io.fetch = async (url) => {
    if (url.endsWith("/api/v1/auth/login")) return loginResponse(200, { cookies: [COOKIE_A] });
    return Response.json({ items: [] });
  };
  const exitCode = await main(["--admin-password-stdin", "service-account", "list"], io);
  assert.equal(exitCode, 0);
});

test("--admin-username overrides the default admin username", async () => {
  let loginBody;
  const { io } = makeIo({ env, stdinText: "pw\n" });
  io.fetch = async (url, init) => {
    if (url.endsWith("/api/v1/auth/login")) {
      loginBody = JSON.parse(init.body);
      return loginResponse(200, { cookies: [COOKIE_A] });
    }
    return Response.json({ id: "root", kind: "admin", username: "root", role: "admin" });
  };
  const exitCode = await main(["whoami", "--admin-username", "root", "--admin-password-stdin"], io);
  assert.equal(exitCode, 0);
  assert.equal(loginBody.username, "root");
});

test("later requests carry the Cookie header from name=value pairs only, and no Authorization header", async () => {
  let seenHeaders;
  const { io } = makeIo({ env, stdinText: "hunter2\n" });
  io.fetch = async (url, init) => {
    if (url.endsWith("/api/v1/auth/login")) {
      return loginResponse(200, {
        cookies: [`${COOKIE_A}; Path=/; HttpOnly; SameSite=Strict`, `${COOKIE_B}; Path=/`],
      });
    }
    seenHeaders = init.headers;
    return Response.json({ id: "admin", kind: "admin", username: "admin", role: "admin" });
  };
  const exitCode = await main(["whoami", "--admin-password-stdin"], io);
  assert.equal(exitCode, 0);
  assert.equal(seenHeaders.cookie, `${COOKIE_A}; ${COOKIE_B}`);
  assert.ok(!("authorization" in seenHeaders));
});

test("the password and cookie never appear in stdout or stderr on success", async () => {
  const { io, stdout, stderr } = makeIo({ env, stdinText: "hunter2\n" });
  io.fetch = async (url) => {
    if (url.endsWith("/api/v1/auth/login")) return loginResponse(200, { cookies: [COOKIE_A] });
    return Response.json({ id: "admin", kind: "admin", username: "admin", role: "admin" });
  };
  const exitCode = await main(["whoami", "--admin-password-stdin"], io);
  assert.equal(exitCode, 0);
  const combined = stdout() + stderr();
  assert.ok(!combined.includes("hunter2"));
  assert.ok(!combined.includes(COOKIE_A));
  assert.ok(!combined.includes("LOGIN_BODY_MARKER_DO_NOT_PRINT"));
});

test("whoami in admin mode prints the admin identity", async () => {
  const { io, stdout } = makeIo({ env, stdinText: "hunter2\n" });
  io.fetch = async (url) => {
    if (url.endsWith("/api/v1/auth/login")) return loginResponse(200, { cookies: [COOKIE_A] });
    return Response.json({ id: "admin-1", kind: "admin", username: "admin", role: "admin" });
  };
  const exitCode = await main(["whoami", "--admin-password-stdin"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /admin/);
  assert.match(stdout(), /admin-1/);
});

test("a 401 login failure exits 1 without leaking the password", async () => {
  const { io, stdout, stderr } = makeIo({ env, stdinText: "wrong-password\n" });
  io.fetch = async (url) => {
    if (url.endsWith("/api/v1/auth/login")) return loginResponse(401);
    throw new Error("must not reach any other endpoint after a failed login");
  };
  const exitCode = await main(["whoami", "--admin-password-stdin"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /admin login failed \(HTTP 401\)/);
  const combined = stdout() + stderr();
  assert.ok(!combined.includes("wrong-password"));
  assert.ok(!combined.includes("LOGIN_BODY_MARKER_DO_NOT_PRINT"));
});

test("combined with HARNESS_API_KEY is a usage error, exit 2, no request made", async () => {
  const { io, stderr } = makeIo({
    env: { ...env, HARNESS_API_KEY: "secret" },
    stdinText: "hunter2\n",
    fetch: refuseFetch,
  });
  const exitCode = await main(["whoami", "--admin-password-stdin"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--admin-password-stdin/);
});

test("combined with --api-key-file is a usage error, exit 2, no request made", async () => {
  const { io, stderr } = makeIo({
    env,
    files: { "/key.txt": "secret" },
    stdinText: "hunter2\n",
    fetch: refuseFetch,
  });
  const exitCode = await main(
    ["whoami", "--admin-password-stdin", "--api-key-file", "/key.txt"],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--admin-password-stdin/);
});

test("combined with `api --body-file -` is a usage error, exit 2, no request made", async () => {
  const { io, stderr } = makeIo({ env, stdinText: "hunter2\n", fetch: refuseFetch });
  const exitCode = await main(
    ["api", "POST", "/repositories", "--body-file", "-", "--admin-password-stdin"],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--admin-password-stdin/);
  assert.match(stderr(), /--body-file/);
});

test("combined with `host inventory set --file -` is a usage error, exit 2, no request made", async () => {
  const { io, stderr } = makeIo({ env, stdinText: "hunter2\n", fetch: refuseFetch });
  const exitCode = await main(
    ["host", "inventory", "set", "host-1", "--file", "-", "--admin-password-stdin"],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--admin-password-stdin/);
  assert.match(stderr(), /--file/);
});
