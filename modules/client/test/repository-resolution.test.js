import assert from "node:assert/strict";
import test from "node:test";

import { AutoHarnessClient, AutoHarnessError } from "../src/index.js";
import { makeClient } from "./make-client.js";

test("resolves a repositoryName to repositoryId before sending", async () => {
  const { client, calls } = makeClient({
    "/api/v1/repositories": () =>
      Response.json({ items: [{ id: "repo-1", name: "voucha" }], nextCursor: null }),
    "/api/v1/sessions": async (init) => {
      assert.equal(JSON.parse(init.body).repositoryId, "repo-1");
      return Response.json({ id: "session", created: true });
    },
  });
  await client.createSession({
    repositoryName: "voucha",
    prompt: "review",
    target: { providerId: "codex" },
    timeout: 60,
  });
  assert.deepEqual(calls, [
    "https://harness.test/api/v1/repositories?limit=100",
    "https://harness.test/api/v1/sessions",
  ]);
});

test("passes an id-shaped repositoryId through with no catalog requests", async () => {
  const { client, calls } = makeClient({
    "/api/v1/sessions": () => Response.json({ id: "session", created: true }),
  });
  await client.createSession({
    repositoryId: "repo-1",
    prompt: "review",
    target: { providerId: "codex" },
    timeout: 60,
  });
  assert.deepEqual(calls, ["https://harness.test/api/v1/sessions"]);
});

test("resolves a repositoryName that also carries an explicit undefined id field", async () => {
  const { client } = makeClient({
    "/api/v1/repositories": () =>
      Response.json({ items: [{ id: "repo-1", name: "voucha" }], nextCursor: null }),
    "/api/v1/sessions": async (init) => {
      assert.equal(JSON.parse(init.body).repositoryId, "repo-1");
      return Response.json({ id: "session", created: true });
    },
  });
  await client.createSession({
    // `repositoryId: undefined` is a common shape from conditional object construction; `in`
    // would see the key and wrongly treat this as already resolved.
    repositoryName: "voucha",
    repositoryId: undefined,
    prompt: "review",
    target: { providerId: "codex" },
    timeout: 60,
  });
});

test("follows nextCursor across every page before searching for a repositoryName match", async () => {
  const requestedUrls = [];
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async (url) => {
      requestedUrls.push(url);
      if (new URL(url).pathname === "/api/v1/sessions") {
        return Response.json({ id: "session", created: true });
      }
      return requestedUrls.length === 1
        ? Response.json({ items: [{ id: "repo-1", name: "other" }], nextCursor: "cursor/1" })
        : Response.json({ items: [{ id: "repo-2", name: "voucha" }], nextCursor: null });
    },
  });
  await client.createSession({
    repositoryName: "voucha",
    prompt: "review",
    target: { providerId: "codex" },
    timeout: 60,
  });
  assert.deepEqual(requestedUrls, [
    "https://harness.test/api/v1/repositories?limit=100",
    "https://harness.test/api/v1/repositories?limit=100&cursor=cursor%2F1",
    "https://harness.test/api/v1/sessions",
  ]);
});

test("throws AutoHarnessError when no repository matches the given name", async () => {
  const { client } = makeClient({
    "/api/v1/repositories": () =>
      Response.json({ items: [{ id: "repo-1", name: "other" }], nextCursor: null }),
  });
  await assert.rejects(
    client.createSession({
      repositoryName: "does-not-exist",
      prompt: "review",
      target: { providerId: "codex" },
      timeout: 60,
    }),
    (error) => {
      assert.ok(error instanceof AutoHarnessError);
      assert.equal(error.code, "UNKNOWN_REPOSITORY_NAME");
      assert.equal(error.status, 400);
      assert.match(error.message, /does-not-exist/);
      return true;
    },
  );
});

test("throws AutoHarnessError on an ambiguous repository name without leaking either id", async () => {
  const duplicateIds = [
    "repo-aaaaaaaa-1111-2222-3333-444444444444",
    "repo-bbbbbbbb-1111-2222-3333-444444444444",
  ];
  const { client } = makeClient({
    "/api/v1/repositories": () =>
      Response.json({
        items: duplicateIds.map((id) => ({ id, name: "shared-name" })),
        nextCursor: null,
      }),
  });
  await assert.rejects(
    client.createSession({
      repositoryName: "shared-name",
      prompt: "review",
      target: { providerId: "codex" },
      timeout: 60,
    }),
    (error) => {
      assert.ok(error instanceof AutoHarnessError);
      assert.equal(error.code, "AMBIGUOUS_REPOSITORY_NAME");
      assert.match(error.message, /shared-name/);
      assert.match(error.message, /2 repositories share this name/);
      for (const id of duplicateIds) assert.ok(!error.message.includes(id));
      return true;
    },
  );
});
