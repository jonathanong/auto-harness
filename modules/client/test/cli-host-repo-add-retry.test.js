import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { makeRecord } from "./host-repo-rm-fixture.js";

const env = { HARNESS_API_URL: "https://harness.test" };
const repository = { id: "repo-c", name: "org/repo-c", url: "https://x", defaultBranch: "main" };
const argv = ["host", "repo", "add", "host-1", "repo-c", "--path", "/repos/c"];

function conflict() {
  return Response.json(
    { error: { code: "CONFLICT", message: "inventory version moved" } },
    { status: 409 },
  );
}

test("409 then success re-reads the inventory and succeeds on attempt 2", async () => {
  const record = makeRecord();
  let getInventoryCount = 0;
  let putCount = 0;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      if (init?.method === "PUT") {
        putCount += 1;
        if (putCount === 1) return conflict();
        const body = JSON.parse(init.body);
        return Response.json({ ...record, repositories: body.repositories, version: 30 });
      }
      if (url.endsWith("/repositories/repo-c")) return Response.json(repository);
      getInventoryCount += 1;
      return Response.json(record);
    },
  });
  const exitCode = await main(argv, io);
  assert.equal(exitCode, 0);
  assert.equal(putCount, 2);
  assert.equal(getInventoryCount, 2);
  assert.match(stdout(), /version 29 → 30/);
});

test("409 three times fails after exactly 3 PUTs", async () => {
  const record = makeRecord();
  let putCount = 0;
  const { io, stderr } = makeIo({
    env,
    fetch: async (url, init) => {
      if (init?.method === "PUT") {
        putCount += 1;
        return conflict();
      }
      if (url.endsWith("/repositories/repo-c")) return Response.json(repository);
      return Response.json(record);
    },
  });
  const exitCode = await main(argv, io);
  assert.equal(exitCode, 1);
  assert.equal(putCount, 3);
  assert.match(stderr(), /kept changing/);
});

test("a 409 then the same repository already attached at the same path converges", async () => {
  const record = makeRecord();
  const recordWithRepoC = {
    ...record,
    repositories: [...record.repositories, { ...repository, path: "/repos/c", worktrees: [] }],
    version: 31,
  };
  let putCount = 0;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      if (init?.method === "PUT") {
        putCount += 1;
        return conflict();
      }
      if (url.endsWith("/repositories/repo-c")) return Response.json(repository);
      return Response.json(putCount === 0 ? record : recordWithRepoC);
    },
  });
  const exitCode = await main(argv, io);
  assert.equal(exitCode, 0);
  assert.equal(putCount, 1);
  assert.match(stdout(), /already attached to host host-1 by another writer at the same path/);
});

test("a 409 then the same repository attached at a different path fails, naming that path", async () => {
  const record = makeRecord();
  const recordWithDifferentPath = {
    ...record,
    repositories: [
      ...record.repositories,
      { ...repository, path: "/somewhere/else", worktrees: [] },
    ],
    version: 31,
  };
  let putCount = 0;
  const { io, stderr } = makeIo({
    env,
    fetch: async (url, init) => {
      if (init?.method === "PUT") {
        putCount += 1;
        return conflict();
      }
      if (url.endsWith("/repositories/repo-c")) return Response.json(repository);
      return Response.json(putCount === 0 ? record : recordWithDifferentPath);
    },
  });
  const exitCode = await main(argv, io);
  assert.equal(exitCode, 1);
  assert.equal(putCount, 1);
  assert.match(
    stderr(),
    /repo-c was attached to host host-1 at \/somewhere\/else by another writer/,
  );
});

test("a 400 is not retried", async () => {
  const record = makeRecord();
  let putCount = 0;
  const { io, stderr } = makeIo({
    env,
    fetch: async (url, init) => {
      if (init?.method === "PUT") {
        putCount += 1;
        return Response.json(
          { error: { code: "VALIDATION_ERROR", message: "bad document" } },
          { status: 400 },
        );
      }
      if (url.endsWith("/repositories/repo-c")) return Response.json(repository);
      return Response.json(record);
    },
  });
  const exitCode = await main(argv, io);
  assert.equal(exitCode, 1);
  assert.equal(putCount, 1);
  assert.match(stderr(), /HTTP 400/);
});
