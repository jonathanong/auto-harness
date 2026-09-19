import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { fetchFor, repositoryRecord } from "./host-repo-add-fixture.js";
import { makeRecord } from "./host-repo-rm-fixture.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("attaches a new repository; PUT body preserves providerAccounts/version/unrelated fields", async () => {
  const record = makeRecord();
  let putBody;
  const { io, stdout } = makeIo({
    env,
    fetch: fetchFor({
      repository: repositoryRecord(),
      onGetInventory: async () => Response.json(record),
      onPut: async (url, init) => {
        putBody = JSON.parse(init.body);
        return Response.json({ ...record, repositories: putBody.repositories, version: 30 });
      },
    }),
  });
  const exitCode = await main(
    ["host", "repo", "add", "host-1", "repo-c", "--path", "/repos/c"],
    io,
  );
  assert.equal(exitCode, 0);
  const expectedEntry = { id: "repo-c", path: "/repos/c", defaultBranch: "main", worktrees: [] };
  assert.deepEqual(putBody, { ...record, repositories: [...record.repositories, expectedEntry] });
  assert.equal(putBody.version, 29);
  assert.deepEqual(putBody.providerAccounts, record.providerAccounts);
  assert.deepEqual(putBody.capabilities, record.capabilities);
  assert.deepEqual(putBody.runtime, record.runtime);
  const text = stdout();
  assert.match(text, /attached repository repo-c \(\/repos\/c\) to host host-1/);
  assert.match(text, /version 29 → 30/);
});

test("--default-branch overrides the target repository's own defaultBranch", async () => {
  const record = makeRecord();
  let putBody;
  const { io } = makeIo({
    env,
    fetch: fetchFor({
      repository: repositoryRecord({ defaultBranch: "main" }),
      onGetInventory: async () => Response.json(record),
      onPut: async (url, init) => {
        putBody = JSON.parse(init.body);
        return Response.json({ ...record, repositories: putBody.repositories, version: 30 });
      },
    }),
  });
  const exitCode = await main(
    ["host", "repo", "add", "host-1", "repo-c", "--path", "/repos/c", "--default-branch", "dev"],
    io,
  );
  assert.equal(exitCode, 0);
  assert.equal(putBody.repositories.at(-1).defaultBranch, "dev");
});

test("omitting --default-branch falls back to the repository's own defaultBranch", async () => {
  const record = makeRecord();
  let putBody;
  const { io } = makeIo({
    env,
    fetch: fetchFor({
      repository: repositoryRecord({ defaultBranch: "trunk" }),
      onGetInventory: async () => Response.json(record),
      onPut: async (url, init) => {
        putBody = JSON.parse(init.body);
        return Response.json({ ...record, repositories: putBody.repositories, version: 30 });
      },
    }),
  });
  const exitCode = await main(
    ["host", "repo", "add", "host-1", "repo-c", "--path", "/repos/c"],
    io,
  );
  assert.equal(exitCode, 0);
  assert.equal(putBody.repositories.at(-1).defaultBranch, "trunk");
});

test("--worktree flags become worktree entries on the new repository, printed by id", async () => {
  const record = makeRecord();
  let putBody;
  const { io, stdout } = makeIo({
    env,
    fetch: fetchFor({
      repository: repositoryRecord(),
      onGetInventory: async () => Response.json(record),
      onPut: async (url, init) => {
        putBody = JSON.parse(init.body);
        return Response.json({ ...record, repositories: putBody.repositories, version: 30 });
      },
    }),
  });
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
      "wt-1=/repos/c/wt-1",
      "--worktree",
      "wt-2=/repos/c/wt-2",
    ],
    io,
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(putBody.repositories.at(-1).worktrees, [
    { id: "wt-1", name: "wt-1", path: "/repos/c/wt-1", labels: [] },
    { id: "wt-2", name: "wt-2", path: "/repos/c/wt-2", labels: [] },
  ]);
  assert.match(stdout(), /worktrees: wt-1, wt-2/);
});

test("--dry-run prints what would be attached and makes no PUT", async () => {
  const record = makeRecord();
  let putCalled = false;
  const { io, stdout } = makeIo({
    env,
    fetch: fetchFor({
      repository: repositoryRecord(),
      onGetInventory: async () => Response.json(record),
      onPut: async () => {
        putCalled = true;
        return Response.json(record);
      },
    }),
  });
  const exitCode = await main(
    ["host", "repo", "add", "host-1", "repo-c", "--path", "/repos/c", "--dry-run"],
    io,
  );
  assert.equal(exitCode, 0);
  assert.equal(putCalled, false);
  const text = stdout();
  assert.match(text, /would attach repository repo-c \(\/repos\/c\) to host host-1/);
  assert.doesNotMatch(text, /worktrees:/);
});

test("--json prints the structured attach result", async () => {
  const record = makeRecord();
  const { io, stdout } = makeIo({
    env,
    fetch: fetchFor({
      repository: repositoryRecord(),
      onGetInventory: async () => Response.json(record),
      onPut: async (url, init) => {
        const body = JSON.parse(init.body);
        return Response.json({ ...record, repositories: body.repositories, version: 30 });
      },
    }),
  });
  const exitCode = await main(
    ["host", "repo", "add", "host-1", "repo-c", "--path", "/repos/c", "--json"],
    io,
  );
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.hostId, "host-1");
  assert.equal(parsed.repository.id, "repo-c");
  assert.deepEqual(parsed.worktreeIds, []);
  assert.equal(parsed.fromVersion, 29);
  assert.equal(parsed.toVersion, 30);
});
