import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { fetchFor, repositoryRecord } from "./host-repo-add-fixture.js";
import { makeRecord } from "./host-repo-rm-fixture.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("a repository already attached to the host fails (exit 1), naming the existing path, no PUT", async () => {
  const record = makeRecord();
  let putCalled = false;
  const { io, stderr } = makeIo({
    env,
    fetch: fetchFor({
      repository: repositoryRecord({ id: "repo-a" }),
      onGetInventory: async () => Response.json(record),
      onPut: async () => {
        putCalled = true;
        return Response.json(record);
      },
    }),
  });
  const exitCode = await main(
    ["host", "repo", "add", "host-1", "repo-a", "--path", "/repos/new-a"],
    io,
  );
  assert.equal(exitCode, 1);
  assert.equal(putCalled, false);
  assert.match(stderr(), /repo-a is already attached to host host-1 at \/repos\/a/);
});

test("--dry-run still refuses an already-attached repository (never overwrite)", async () => {
  const record = makeRecord();
  const { io, stderr } = makeIo({
    env,
    fetch: fetchFor({
      repository: repositoryRecord({ id: "repo-a" }),
      onGetInventory: async () => Response.json(record),
      onPut: async () => {
        throw new Error("unexpected PUT in test");
      },
    }),
  });
  const exitCode = await main(
    ["host", "repo", "add", "host-1", "repo-a", "--path", "/repos/new-a", "--dry-run"],
    io,
  );
  assert.equal(exitCode, 1);
  assert.match(stderr(), /repo-a is already attached to host host-1 at \/repos\/a/);
});

test("a 404 from GET /repositories/<id> becomes a clear error naming the id; no inventory GET", async () => {
  let inventoryFetched = false;
  const { io, stderr } = makeIo({
    env,
    fetch: fetchFor({
      repository: Response.json(
        { error: { code: "NOT_FOUND", message: "repository not found" } },
        { status: 404 },
      ),
      onGetInventory: async () => {
        inventoryFetched = true;
        return Response.json(makeRecord());
      },
      onPut: async () => {
        throw new Error("unexpected PUT in test");
      },
    }),
  });
  const exitCode = await main(
    ["host", "repo", "add", "host-1", "repo-c", "--path", "/repos/c"],
    io,
  );
  assert.equal(exitCode, 1);
  assert.equal(inventoryFetched, false);
  assert.match(stderr(), /repository repo-c not found/);
});

test("a non-404 error from GET /repositories/<id> goes through the normal error path", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: fetchFor({
      repository: Response.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      onGetInventory: async () => Response.json(makeRecord()),
      onPut: async () => {
        throw new Error("unexpected PUT in test");
      },
    }),
  });
  const exitCode = await main(
    ["host", "repo", "add", "host-1", "repo-c", "--path", "/repos/c"],
    io,
  );
  assert.equal(exitCode, 1);
  assert.match(stderr(), /boom/);
  assert.match(stderr(), /HTTP 500/);
});

test("requires hostId, repositoryId, and --path", async () => {
  const { io, stderr } = makeIo({ env });
  for (const argv of [
    ["host", "repo", "add"],
    ["host", "repo", "add", "host-1"],
    ["host", "repo", "add", "host-1", "repo-c"],
    ["host", "repo", "add", "host-1", "repo-c", "extra", "--path", "/x"],
  ]) {
    const exitCode = await main(argv, io);
    assert.equal(exitCode, 2);
    assert.match(stderr(), /usage: auto-harness host repo add/);
  }
});

test("a malformed --worktree value is a usage error and sends nothing", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(
    ["host", "repo", "add", "host-1", "repo-c", "--path", "/repos/c", "--worktree", "no-equals"],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--worktree must be <id>=<path>/);
});

test("a duplicate --worktree id is a usage error and sends nothing", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(
    [
      "host",
      "repo",
      "add",
      "host-1",
      "repo-c",
      "--path",
      "/repos/c",
      "--worktree",
      "wt-1=/a",
      "--worktree",
      "wt-1=/b",
    ],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--worktree id given more than once: wt-1/);
});
