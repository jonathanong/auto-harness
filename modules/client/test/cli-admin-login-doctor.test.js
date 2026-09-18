import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { COOKIE_A, env, loginResponse } from "./admin-login-fixture.js";
import { makeIo } from "./cli-helpers.js";

const healthy = async () => Response.json({ ok: true });

test("doctor in admin mode reports the admin identity on a successful login", async () => {
  const { io, stdout } = makeIo({ env, stdinText: "hunter2\n" });
  io.fetch = async (url) => {
    if (url.endsWith("/health")) return healthy();
    if (url.endsWith("/api/v1/auth/login")) return loginResponse(200, { cookies: [COOKIE_A] });
    return Response.json({ id: "admin-1", kind: "admin", username: "admin", role: "admin" });
  };
  const exitCode = await main(["doctor", "--admin-password-stdin"], io);
  assert.equal(exitCode, 0);
  const text = stdout();
  assert.match(text, /ok auth: authenticated as admin \(role admin; capabilities: none\)/);
  assert.ok(!text.includes("hunter2"));
});

test("doctor's url/reachability checks still print when the admin password is wrong", async () => {
  const { io, stdout } = makeIo({ env, stdinText: "wrong\n" });
  io.fetch = async (url) => {
    if (url.endsWith("/health")) return healthy();
    if (url.endsWith("/api/v1/auth/login")) return loginResponse(401);
    throw new Error("must not reach /auth/me after a failed login");
  };
  const exitCode = await main(["doctor", "--admin-password-stdin"], io);
  assert.equal(exitCode, 1);
  const text = stdout();
  assert.match(text, /ok url:/);
  assert.match(text, /ok reachability: control plane is reachable/);
  assert.match(text, /fail auth: admin login failed \(HTTP 401\)/);
  assert.ok(!text.includes("wrong"));
});
