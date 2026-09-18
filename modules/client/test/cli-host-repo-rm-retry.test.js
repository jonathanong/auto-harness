import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { makeRecord } from "./host-repo-rm-fixture.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("409 then success re-reads the inventory and succeeds on attempt 2", async () => {
  const record = makeRecord();
  let getCount = 0;
  let putCount = 0;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      if (init?.method === "PUT") {
        putCount += 1;
        if (putCount === 1) {
          return Response.json(
            { error: { code: "CONFLICT", message: "inventory version moved" } },
            { status: 409 },
          );
        }
        return Response.json({ ...record, repositories: [record.repositories[1]], version: 30 });
      }
      getCount += 1;
      return Response.json(record);
    },
  });
  const exitCode = await main(["host", "repo", "rm", "host-1", "repo-a"], io);
  assert.equal(exitCode, 0);
  assert.equal(putCount, 2);
  assert.equal(getCount, 2);
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
        return Response.json(
          { error: { code: "CONFLICT", message: "inventory version moved" } },
          { status: 409 },
        );
      }
      return Response.json(record);
    },
  });
  const exitCode = await main(["host", "repo", "rm", "host-1", "repo-a"], io);
  assert.equal(exitCode, 1);
  assert.equal(putCount, 3);
  assert.match(stderr(), /kept changing/);
});

test("a repository already removed by another writer converges instead of erroring", async () => {
  const record = makeRecord();
  const recordWithoutRepoA = { ...record, repositories: [record.repositories[1]], version: 31 };
  let putCount = 0;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      if (init?.method === "PUT") {
        putCount += 1;
        return Response.json(
          { error: { code: "CONFLICT", message: "inventory version moved" } },
          { status: 409 },
        );
      }
      return Response.json(putCount === 0 ? record : recordWithoutRepoA);
    },
  });
  const exitCode = await main(["host", "repo", "rm", "host-1", "repo-a"], io);
  assert.equal(exitCode, 0);
  assert.equal(putCount, 1);
  assert.match(stdout(), /already removed/);
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
      return Response.json(record);
    },
  });
  const exitCode = await main(["host", "repo", "rm", "host-1", "repo-a"], io);
  assert.equal(exitCode, 1);
  assert.equal(putCount, 1);
  assert.match(stderr(), /HTTP 400/);
});
