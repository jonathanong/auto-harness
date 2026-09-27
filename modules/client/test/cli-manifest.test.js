import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { usage } from "../src/cli/usage.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

function calls() {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
    });
    return Response.json({ ok: true });
  };
  return { seen, fetch };
}

test("help lists manifest commands", () => {
  assert.match(usage(), /auto-harness provider list/);
  assert.match(usage(), /auto-harness repo session-drain release/);
  assert.match(usage(), /auto-harness usage list --repository-id <value>/);
});

test("provider list sends GET /providers with the limit query", async () => {
  const { seen, fetch } = calls();
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main(["provider", "list", "--limit", "10"], io);
  assert.equal(exitCode, 0);
  assert.equal(seen[0].url, "https://harness.test/api/v1/providers?limit=10");
  assert.equal(seen[0].method, "GET");
  assert.match(stdout(), /"ok": true/);
});

test("session list is dispatched from the session command", async () => {
  const { seen, fetch } = calls();
  const { io } = makeIo({ env, fetch });
  const exitCode = await main(
    ["session", "list", "--status", "running", "--repository-id", "repo-1"],
    io,
  );
  assert.equal(exitCode, 0);
  assert.equal(
    seen[0].url,
    "https://harness.test/api/v1/sessions?status=running&repositoryId=repo-1",
  );
});

test("repo update defaults to PATCH and --method put sends PUT", async () => {
  const { seen, fetch } = calls();
  const { io } = makeIo({ env, fetch });
  assert.equal(await main(["repo", "update", "repo-1", "--body", '{"name":"next"}'], io), 0);
  assert.equal(seen[0].method, "PATCH");
  assert.equal(seen[0].url, "https://harness.test/api/v1/repositories/repo-1");
  assert.equal(await main(["repo", "update", "repo-1", "--method", "put", "--body", "{}"], io), 0);
  assert.equal(seen[1].method, "PUT");
});

test("user create refuses an inline body and does not echo it", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["user", "create", "--body", "super-secret-password"], io);
  assert.equal(exitCode, 2);
  assert.equal(stderr().includes("super-secret-password"), false);
  assert.match(stderr(), /--body is not accepted/);
});

test("user create posts the file body", async () => {
  const { seen, fetch } = calls();
  const { io } = makeIo({
    env,
    fetch,
    files: { "./user.json": '{"username":"ada","password":"x"}' },
  });
  const exitCode = await main(["user", "create", "--body-file", "./user.json"], io);
  assert.equal(exitCode, 0);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "https://harness.test/api/v1/auth/users");
  assert.deepEqual(JSON.parse(seen[0].body), { username: "ada", password: "x" });
});

test("usage list requires --repository-id before any request", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  assert.equal(await main(["usage", "list"], io), 2);
  assert.match(stderr(), /--repository-id is required/);
});

test("session-drain start forwards the idempotency header", async () => {
  const { seen, fetch } = calls();
  const { io } = makeIo({ env, fetch });
  const exitCode = await main(
    ["repo", "session-drain", "start", "repo 1", "--idempotency-key", "deploy-1"],
    io,
  );
  assert.equal(exitCode, 0);
  assert.equal(seen[0].url, "https://harness.test/api/v1/repositories/repo%201/session-drains");
  assert.equal(seen[0].headers["Idempotency-Key"], "deploy-1");
});

test("github integration delete requires the match headers", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  assert.equal(await main(["integration", "github", "rm"], io), 2);
  assert.match(stderr(), /--if-match is required/);
});

test("a 204 response prints nothing", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => new Response(null, { status: 204 }),
  });
  assert.equal(await main(["user", "rm", "ada"], io), 0);
  assert.equal(stdout(), "");
});

test("dot segments are rejected before a request", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  assert.equal(await main(["host", "get", ".."], io), 2);
  assert.match(stderr(), /must not be "\." or "\.\."/);
});

test("--all stops after 20 pages and warns", async () => {
  let count = 0;
  const { io, stderr, stdout } = makeIo({
    env,
    fetch: async () => {
      count += 1;
      return Response.json({ items: [{ id: count }], nextCursor: `cursor-${count}` });
    },
  });
  assert.equal(await main(["provider", "list", "--all"], io), 0);
  assert.equal(count, 20);
  assert.match(stderr(), /stopped after 20 pages/);
  assert.equal(JSON.parse(stdout()).items.length, 20);
});

test("a repeated page cursor fails", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => Response.json({ items: [], nextCursor: "same" }),
  });
  assert.equal(await main(["schedule", "list", "--all"], io), 1);
  assert.match(stderr(), /repeated pagination cursor/);
});
