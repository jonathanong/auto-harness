import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { makeRecord } from "./host-repo-rm-fixture.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("repo rm PUT body is the read record with only the target repository removed", async () => {
  const record = makeRecord();
  let putBody;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(init.body);
        return Response.json({ ...record, repositories: [record.repositories[1]], version: 30 });
      }
      return Response.json(record);
    },
  });
  const exitCode = await main(["host", "repo", "rm", "host-1", "repo-a"], io);
  assert.equal(exitCode, 0);
  assert.deepEqual(putBody, { ...record, repositories: [record.repositories[1]] });
  assert.equal(putBody.version, 29);
  assert.deepEqual(putBody.providerAccounts, record.providerAccounts);
  assert.deepEqual(putBody.capabilities, record.capabilities);
  assert.deepEqual(putBody.runtime, record.runtime);
  const text = stdout();
  assert.match(text, /repo-a/);
  assert.match(text, /wt-1/);
  assert.match(text, /wt-2/);
  assert.match(text, /version 29 → 30/);
});

test("unknown repository is an exit-1 error listing attached ids, and makes no PUT", async () => {
  const record = makeRecord();
  let putCalled = false;
  const { io, stderr } = makeIo({
    env,
    fetch: async (url, init) => {
      if (init?.method === "PUT") putCalled = true;
      return Response.json(record);
    },
  });
  const exitCode = await main(["host", "repo", "rm", "host-1", "repo-zzz"], io);
  assert.equal(exitCode, 1);
  assert.equal(putCalled, false);
  const text = stderr();
  assert.match(text, /repo-zzz/);
  assert.match(text, /repo-a/);
  assert.match(text, /repo-b/);
});

test("--dry-run prints what would be removed and makes no PUT", async () => {
  const record = makeRecord();
  let putCalled = false;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      if (init?.method === "PUT") putCalled = true;
      return Response.json(record);
    },
  });
  const exitCode = await main(["host", "repo", "rm", "host-1", "repo-a", "--dry-run"], io);
  assert.equal(exitCode, 0);
  assert.equal(putCalled, false);
  const text = stdout();
  assert.match(text, /repo-a/);
  assert.match(text, /\/repos\/a/);
  assert.match(text, /wt-1/);
  assert.match(text, /wt-2/);
});

test("repo rm requires exactly two positional arguments", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["host", "repo", "rm", "host-1"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness host repo rm/);
});

test("repo rm --json prints structured output", async () => {
  const record = makeRecord();
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      if (init?.method === "PUT") {
        return Response.json({ ...record, repositories: [record.repositories[1]], version: 30 });
      }
      return Response.json(record);
    },
  });
  const exitCode = await main(["host", "repo", "rm", "host-1", "repo-a", "--json"], io);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.repository.id, "repo-a");
  assert.deepEqual(parsed.worktreeIds, ["wt-1", "wt-2"]);
  assert.equal(parsed.fromVersion, 29);
  assert.equal(parsed.toVersion, 30);
});
