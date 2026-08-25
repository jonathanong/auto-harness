import assert from "node:assert/strict";
import test from "node:test";

import { AutoHarnessClient } from "../src/index.js";

test("creates a session with an explicit honored source", async () => {
  let request;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async (url, init) => {
      request = init;
      return Response.json({ id: "session", created: true, type: "prompt", source: "webhook" });
    },
  });
  await client.createSession({
    repositoryId: "repo",
    prompt: "review",
    target: { providerId: "codex" },
    source: "webhook",
  });
  assert.deepEqual(JSON.parse(request.body), {
    repositoryId: "repo",
    prompt: "review",
    target: { providerId: "codex" },
    source: "webhook",
  });
});

test("resumes a session with an optional body", async () => {
  let request;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async (url, init) => {
      request = { url, init };
      return Response.json({
        id: "session",
        status: "queued",
        resumedFromSessionId: "session/prior",
      });
    },
  });
  await client.resumeSession("session/prior", { prompt: "retry", priority: 5 });
  assert.equal(request.url, "https://harness.test/api/v1/sessions/session%2Fprior/resume");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.body, JSON.stringify({ prompt: "retry", priority: 5 }));
});

test("resumes a session with no body when no input is given", async () => {
  let request;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async (url, init) => {
      request = { url, init };
      return Response.json({ id: "session", status: "queued" });
    },
  });
  await client.resumeSession("session-1");
  assert.equal(request.init.body, undefined);
  assert.equal(request.init.headers["content-type"], undefined);
});

test("lists sessions with filters and bounded pagination controls", async () => {
  const requestedUrls = [];
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async (url) => {
      requestedUrls.push(url);
      return requestedUrls.length === 1
        ? Response.json({ items: [{ id: "session-1" }], nextCursor: "cursor/one" })
        : Response.json({ items: [{ id: "session-2" }], nextCursor: null });
    },
  });
  const first = await client.listSessions({
    repositoryId: "repo-1",
    status: "running",
    source: "api",
    sort: "priority_desc",
    limit: 1,
  });
  assert.deepEqual(first, { items: [{ id: "session-1" }], nextCursor: "cursor/one" });
  assert.deepEqual(await client.listSessions({ limit: 1, cursor: first.nextCursor }), {
    items: [{ id: "session-2" }],
    nextCursor: null,
  });
  assert.deepEqual(requestedUrls, [
    "https://harness.test/api/v1/sessions?status=running&repositoryId=repo-1&source=api&sort=priority_desc&limit=1",
    "https://harness.test/api/v1/sessions?limit=1&cursor=cursor%2Fone",
  ]);
});

test("preserves the no-argument session listing URL", async () => {
  let request;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test/api/v1/",
    fetch: async (url) => {
      request = url;
      return Response.json({ items: [], nextCursor: null });
    },
  });

  await client.listSessions();

  assert.equal(request, "https://harness.test/api/v1/sessions");
});

test("encodes the session identifier when resuming", async () => {
  let request;
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async (url, init) => {
      request = { url, method: init?.method };
      return Response.json({});
    },
  });
  await client.resumeSession("session/three");
  assert.deepEqual(request, {
    url: "https://harness.test/api/v1/sessions/session%2Fthree/resume",
    method: "POST",
  });
});
