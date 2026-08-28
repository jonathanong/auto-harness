import assert from "node:assert/strict";
import test from "node:test";

import { AutoHarnessError } from "../src/index.js";
import { makeClient } from "./make-client.js";

test("resolves a providerName target to providerId before sending", async () => {
  const { client, calls } = makeClient({
    "/api/v1/providers": () => Response.json({ items: [{ id: "prov-1", name: "codex" }] }),
    "/api/v1/sessions": async (init) => {
      assert.deepEqual(JSON.parse(init.body).target, { providerId: "prov-1" });
      return Response.json({ id: "session", created: true });
    },
  });
  await client.createSession({
    repositoryId: "repo",
    prompt: "review",
    target: { providerName: "codex" },
    timeout: 60,
  });
  assert.deepEqual(calls, [
    "https://harness.test/api/v1/providers",
    "https://harness.test/api/v1/sessions",
  ]);
});

test("resolves a commandName target to commandId before sending", async () => {
  const { client } = makeClient({
    "/api/v1/commands": () =>
      Response.json({ items: [{ id: "cmd-1", name: "claude-print-plan" }] }),
    "/api/v1/sessions": async (init) => {
      assert.deepEqual(JSON.parse(init.body).target, { commandId: "cmd-1" });
      return Response.json({ id: "session", created: true });
    },
  });
  await client.createSession({
    repositoryId: "repo",
    prompt: "review",
    target: { commandName: "claude-print-plan" },
    timeout: 60,
  });
});

test("passes id-shaped target and fallbacks through with no catalog requests", async () => {
  const { client, calls } = makeClient({
    "/api/v1/sessions": () => Response.json({ id: "session", created: true }),
  });
  await client.createSession({
    repositoryId: "repo",
    prompt: "review",
    target: { providerId: "prov-1" },
    fallbacks: [{ commandId: "cmd-1" }],
    timeout: 60,
  });
  assert.deepEqual(calls, ["https://harness.test/api/v1/sessions"]);
});

test("resolves name-based target and fallbacks with one catalog fetch each", async () => {
  let providerRequests = 0;
  let commandRequests = 0;
  const { client } = makeClient({
    "/api/v1/providers": () => {
      providerRequests++;
      return Response.json({
        items: [
          { id: "prov-1", name: "codex" },
          { id: "prov-2", name: "claude" },
        ],
      });
    },
    "/api/v1/commands": () => {
      commandRequests++;
      return Response.json({ items: [{ id: "cmd-1", name: "claude-print-plan" }] });
    },
    "/api/v1/sessions": async (init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.target, { providerId: "prov-1" });
      assert.deepEqual(body.fallbacks, [{ providerId: "prov-2" }, { commandId: "cmd-1" }]);
      return Response.json({ id: "session", created: true });
    },
  });
  await client.createSession({
    repositoryId: "repo",
    prompt: "review",
    target: { providerName: "codex" },
    fallbacks: [{ providerName: "claude" }, { commandName: "claude-print-plan" }],
    timeout: 60,
  });
  assert.equal(providerRequests, 1);
  assert.equal(commandRequests, 1);
});

test("throws AutoHarnessError when no provider matches the given name", async () => {
  const { client } = makeClient({
    "/api/v1/providers": () => Response.json({ items: [{ id: "prov-1", name: "codex" }] }),
  });
  await assert.rejects(
    client.createSession({
      repositoryId: "repo",
      prompt: "review",
      target: { providerName: "does-not-exist" },
      timeout: 60,
    }),
    (error) => {
      assert.ok(error instanceof AutoHarnessError);
      assert.equal(error.code, "UNKNOWN_PROVIDER_NAME");
      assert.equal(error.status, 400);
      assert.match(error.message, /does-not-exist/);
      return true;
    },
  );
});

test("throws AutoHarnessError when no command matches the given name", async () => {
  const { client } = makeClient({
    "/api/v1/commands": () => Response.json({ items: [{ id: "cmd-1", name: "claude-print" }] }),
  });
  await assert.rejects(
    client.createSession({
      repositoryId: "repo",
      prompt: "review",
      target: { commandName: "does-not-exist" },
      timeout: 60,
    }),
    (error) => {
      assert.ok(error instanceof AutoHarnessError);
      assert.equal(error.code, "UNKNOWN_COMMAND_NAME");
      assert.equal(error.status, 400);
      return true;
    },
  );
});
