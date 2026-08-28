import assert from "node:assert/strict";
import test from "node:test";

import { AutoHarnessError } from "../src/index.js";
import { makeClient } from "./make-client.js";

test("throws AutoHarnessError on an ambiguous command name without leaking either id", async () => {
  const duplicateIds = [
    "cmd-aaaaaaaa-1111-2222-3333-444444444444",
    "cmd-bbbbbbbb-1111-2222-3333-444444444444",
  ];
  const { client } = makeClient({
    "/api/v1/commands": () =>
      Response.json({ items: duplicateIds.map((id) => ({ id, name: "shared-name" })) }),
  });
  await assert.rejects(
    client.createSession({
      repositoryId: "repo",
      prompt: "review",
      target: { commandName: "shared-name" },
      timeout: 60,
    }),
    (error) => {
      assert.ok(error instanceof AutoHarnessError);
      assert.equal(error.code, "AMBIGUOUS_COMMAND_NAME");
      assert.match(error.message, /shared-name/);
      assert.match(error.message, /2 commands share this name/);
      for (const id of duplicateIds) assert.ok(!error.message.includes(id));
      return true;
    },
  );
});

test("throws AutoHarnessError on an ambiguous provider name without leaking either id", async () => {
  const duplicateIds = [
    "prov-aaaaaaaa-1111-2222-3333-444444444444",
    "prov-bbbbbbbb-1111-2222-3333-444444444444",
  ];
  const { client } = makeClient({
    "/api/v1/providers": () =>
      Response.json({ items: duplicateIds.map((id) => ({ id, name: "shared-name" })) }),
  });
  await assert.rejects(
    client.createSession({
      repositoryId: "repo",
      prompt: "review",
      target: { providerName: "shared-name" },
      timeout: 60,
    }),
    (error) => {
      assert.ok(error instanceof AutoHarnessError);
      assert.equal(error.code, "AMBIGUOUS_PROVIDER_NAME");
      assert.match(error.message, /shared-name/);
      assert.match(error.message, /2 providers share this name/);
      for (const id of duplicateIds) assert.ok(!error.message.includes(id));
      return true;
    },
  );
});

test("resolves a name ref that also carries an explicit undefined id field", async () => {
  const { client } = makeClient({
    "/api/v1/providers": () => Response.json({ items: [{ id: "prov-1", name: "codex" }] }),
    "/api/v1/sessions": async (init) => {
      assert.deepEqual(JSON.parse(init.body).target, { providerId: "prov-1" });
      return Response.json({ id: "session", created: true });
    },
  });
  await client.createSession({
    repositoryId: "repo",
    prompt: "review",
    // `providerId: undefined` is a common shape from conditional object construction; `in`
    // would see the key and wrongly treat this as already resolved.
    target: { providerName: "codex", providerId: undefined },
    timeout: 60,
  });
});

test("lists providers by unwrapping the items envelope", async () => {
  const { client } = makeClient({
    "/api/v1/providers": () => Response.json({ items: [{ id: "prov-1", name: "codex" }] }),
  });
  assert.deepEqual(await client.listProviders(), [{ id: "prov-1", name: "codex" }]);
});

test("lists commands by unwrapping the items envelope", async () => {
  const { client } = makeClient({
    "/api/v1/commands": () => Response.json({ items: [{ id: "cmd-1", name: "claude-print" }] }),
  });
  assert.deepEqual(await client.listCommands(), [{ id: "cmd-1", name: "claude-print" }]);
});
