import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

const record = {
  hostId: "host-1",
  version: 5,
  repositories: [
    { id: "repo-a", path: "/repos/a", defaultBranch: "main", worktrees: [{ id: "wt-1" }] },
    { id: "repo-b", path: "/repos/b", defaultBranch: "main", worktrees: [] },
  ],
  providerAccounts: [{ providerAccountId: "acct-1" }],
};

test("inventory get, human output", async () => {
  let seenUrl;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url) => {
      seenUrl = url;
      return Response.json(record);
    },
  });
  const exitCode = await main(["host", "inventory", "get", "host-1"], io);
  assert.equal(exitCode, 0);
  assert.equal(seenUrl, "https://harness.test/api/v1/hosts/host-1/inventory");
  const text = stdout();
  assert.match(text, /version: 5/);
  assert.match(text, /repo-a\s+\/repos\/a\s+\(1 worktree\)/);
  assert.match(text, /repo-b\s+\/repos\/b\s+\(0 worktrees\)/);
  assert.match(text, /provider accounts: 1/);
});

test("inventory get --json prints the raw record", async () => {
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json(record) });
  const exitCode = await main(["host", "inventory", "get", "host-1", "--json"], io);
  assert.equal(exitCode, 0);
  assert.equal(stdout(), `${JSON.stringify(record, null, 2)}\n`);
});

test("inventory get with no repositories prints (none)", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ hostId: "host-1", version: 1, repositories: [] }),
  });
  const exitCode = await main(["host", "inventory", "get", "host-1"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /repositories: \(none\)/);
});

test("inventory get requires exactly one hostId argument", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["host", "inventory", "get"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness host inventory get/);
});
