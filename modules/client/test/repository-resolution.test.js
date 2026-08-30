import assert from "node:assert/strict";
import test from "node:test";

import { AutoHarnessError } from "../src/index.js";
import { makeClient } from "./make-client.js";

test("resolves a repositoryName to repositoryId before sending", async () => {
  const { client, calls } = makeClient({
    "/api/v1/repositories": () =>
      Response.json({ items: [{ id: "repo-1", name: "svc-a" }], nextCursor: null }),
    "/api/v1/sessions": async (init) => {
      assert.equal(JSON.parse(init.body).repositoryId, "repo-1");
      return Response.json({ id: "session", created: true });
    },
  });
  await client.createSession({
    repositoryName: "svc-a",
    prompt: "review",
    target: { providerId: "codex" },
    timeout: 60,
  });
  assert.deepEqual(calls, [
    "https://harness.test/api/v1/repositories",
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
    target: { providerId: "prov-1" },
    timeout: 60,
  });
  assert.deepEqual(calls, ["https://harness.test/api/v1/sessions"]);
});

test("resolves a repositoryName across multiple pages of listRepositories", async () => {
  let page = 0;
  const { client, calls } = makeClient({
    "/api/v1/repositories": () => {
      page += 1;
      return page === 1
        ? Response.json({ items: [{ id: "repo-1", name: "svc-a" }], nextCursor: "cursor-1" })
        : Response.json({ items: [{ id: "repo-2", name: "svc-b" }], nextCursor: null });
    },
    "/api/v1/sessions": async (init) => {
      assert.equal(JSON.parse(init.body).repositoryId, "repo-2");
      return Response.json({ id: "session", created: true });
    },
  });
  await client.createSession({
    repositoryName: "svc-b",
    prompt: "review",
    target: { providerId: "codex" },
    timeout: 60,
  });
  assert.equal(page, 2);
  assert.deepEqual(calls, [
    "https://harness.test/api/v1/repositories",
    "https://harness.test/api/v1/repositories?cursor=cursor-1",
    "https://harness.test/api/v1/sessions",
  ]);
});

test("resolves a repositoryName for startSessionDrain, getSessionDrain, and releaseSessionDrain", async () => {
  const { client } = makeClient({
    "/api/v1/repositories": () =>
      Response.json({ items: [{ id: "repo-1", name: "svc-a" }], nextCursor: null }),
    "/api/v1/repositories/repo-1/session-drains": async (init) => {
      assert.equal(init.method, "POST");
      return Response.json({ operationId: "drain-1", status: "draining" });
    },
    "/api/v1/repositories/repo-1/session-drains/drain-1": () =>
      Response.json({ operationId: "drain-1", status: "succeeded" }),
    "/api/v1/repositories/repo-1/session-drains/drain-1/release": async (init) => {
      assert.equal(init.method, "POST");
      return Response.json({ operationId: "drain-1", status: "released" });
    },
  });
  const ref = { repositoryName: "svc-a" };
  assert.equal((await client.startSessionDrain(ref)).operationId, "drain-1");
  assert.equal((await client.getSessionDrain(ref, "drain-1")).status, "succeeded");
  assert.equal((await client.releaseSessionDrain(ref, "drain-1")).status, "released");
});

test("throws AutoHarnessError when no repository matches the given name", async () => {
  const { client } = makeClient({
    "/api/v1/repositories": () =>
      Response.json({ items: [{ id: "repo-1", name: "svc-a" }], nextCursor: null }),
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
  const duplicateIds = ["repo-aaaaaaaa-1111-2222-3333-444444444444", "repo-bbbbbbbb-1111-2222"];
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
