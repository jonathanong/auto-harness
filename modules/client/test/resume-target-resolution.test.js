import assert from "node:assert/strict";
import test from "node:test";

import { makeClient } from "./make-client.js";

test("resolves a commandName override to commandId before sending a resume", async () => {
  const { client, calls } = makeClient({
    "/api/v1/commands": () =>
      Response.json({ items: [{ id: "cmd-new", name: "claude-print-auto" }] }),
    "/api/v1/sessions/sess-1/resume": async (init) => {
      assert.deepEqual(JSON.parse(init.body).target, { commandId: "cmd-new" });
      return Response.json({ id: "sess-2", created: true });
    },
  });
  await client.resumeSession("sess-1", { target: { commandName: "claude-print-auto" } });
  assert.deepEqual(calls, [
    "https://harness.test/api/v1/commands",
    "https://harness.test/api/v1/sessions/sess-1/resume",
  ]);
});

test("passes an id-shaped target and fallbacks through with no catalog requests", async () => {
  const { client, calls } = makeClient({
    "/api/v1/sessions/sess-1/resume": () => Response.json({ id: "sess-2", created: true }),
  });
  await client.resumeSession("sess-1", {
    target: { commandId: "cmd-new" },
    fallbacks: [{ providerId: "prov-1" }],
  });
  assert.deepEqual(calls, ["https://harness.test/api/v1/sessions/sess-1/resume"]);
});

test("makes no catalog request for an id-only or bodyless resume", async () => {
  const { client, calls } = makeClient({
    "/api/v1/sessions/sess-1/resume": () => Response.json({ id: "sess-2", created: true }),
  });
  await client.resumeSession("sess-1");
  await client.resumeSession("sess-1", { prompt: "continue" });
  assert.deepEqual(calls, [
    "https://harness.test/api/v1/sessions/sess-1/resume",
    "https://harness.test/api/v1/sessions/sess-1/resume",
  ]);
});
