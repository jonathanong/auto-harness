import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("service-account rm deletes on 204, human output", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      assert.equal(init.method, "DELETE");
      assert.match(url, /\/auth\/service-accounts\/svc-1$/);
      return new Response(null, { status: 204 });
    },
  });
  const exitCode = await main(["service-account", "rm", "svc-1"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /svc-1 deleted/);
});

test("service-account rm --json prints { deleted: true, id } on success", async () => {
  const { io, stdout } = makeIo({ env, fetch: async () => new Response(null, { status: 204 }) });
  const exitCode = await main(["service-account", "rm", "svc-1", "--json"], io);
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout()), { deleted: true, id: "svc-1" });
});

test("a 404 goes through the normal error path, exit 1", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json(
        { error: { code: "NOT_FOUND", message: "service account not found" } },
        { status: 404 },
      ),
  });
  const exitCode = await main(["service-account", "rm", "svc-1"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /service account not found/);
});

test("a conflict prints dependencies generically (kind + id), exit 1", async () => {
  const dependencies = [
    { kind: "schedule", id: "sched-1" },
    { kind: "session-drain", id: "drain-1", status: "draining" },
  ];
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json(
        { error: { code: "CONFLICT", message: "cannot delete account", dependencies } },
        { status: 409 },
      ),
  });
  const exitCode = await main(["service-account", "rm", "svc-1"], io);
  assert.equal(exitCode, 1);
  const text = stderr();
  assert.match(text, /cannot delete account/);
  assert.match(text, /schedule sched-1/);
  assert.match(text, /session-drain drain-1/);
});

test("a conflict --json prints { deleted: false, id, dependencies }", async () => {
  const dependencies = [{ kind: "schedule", id: "sched-1" }];
  const { io, stdout } = makeIo({
    env,
    fetch: async () =>
      Response.json(
        { error: { code: "CONFLICT", message: "cannot delete account", dependencies } },
        { status: 409 },
      ),
  });
  const exitCode = await main(["service-account", "rm", "svc-1", "--json"], io);
  assert.equal(exitCode, 1);
  const parsed = JSON.parse(stdout());
  assert.deepEqual(parsed, { deleted: false, id: "svc-1", dependencies });
});

test("service-account rm requires exactly one positional argument", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["service-account", "rm"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness service-account rm/);
});
