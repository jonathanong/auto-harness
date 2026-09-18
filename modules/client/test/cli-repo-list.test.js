import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("repo list prints one line per repository, human format", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () =>
      Response.json({
        items: [
          { id: "repo-1", name: "org/repo-1", status: "active", url: "https://x/repo-1" },
          { id: "repo-2", name: "org/repo-2" },
        ],
      }),
  });
  const exitCode = await main(["repo", "list"], io);
  assert.equal(exitCode, 0);
  const text = stdout();
  assert.match(text, /repo-1\s+org\/repo-1\s+active\s+https:\/\/x\/repo-1/);
  assert.match(text, /repo-2\s+org\/repo-2/);
});

test("repo list --json prints the raw page", async () => {
  const page = { items: [{ id: "repo-1", name: "org/repo-1" }], nextCursor: null };
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json(page) });
  const exitCode = await main(["repo", "list", "--json"], io);
  assert.equal(exitCode, 0);
  assert.equal(stdout(), `${JSON.stringify(page, null, 2)}\n`);
});

test("--limit and --cursor reach the query string", async () => {
  let seenUrl;
  const { io } = makeIo({
    env,
    fetch: async (url) => {
      seenUrl = url;
      return Response.json({ items: [] });
    },
  });
  await main(["repo", "list", "--limit", "5", "--cursor", "abc"], io);
  assert.match(seenUrl, /limit=5/);
  assert.match(seenUrl, /cursor=abc/);
});

test("a nextCursor prints a hint unless --all", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ items: [], nextCursor: "abc123" }),
  });
  const exitCode = await main(["repo", "list"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /abc123/);
});

test("--all follows nextCursor across pages and reports no hint", async () => {
  let call = 0;
  const { io, stdout } = makeIo({
    env,
    fetch: async () => {
      call += 1;
      if (call === 1) {
        return Response.json({ items: [{ id: "repo-1", name: "r1" }], nextCursor: "c2" });
      }
      return Response.json({ items: [{ id: "repo-2", name: "r2" }] });
    },
  });
  const exitCode = await main(["repo", "list", "--all"], io);
  assert.equal(exitCode, 0);
  assert.equal(call, 2);
  const text = stdout();
  assert.match(text, /repo-1/);
  assert.match(text, /repo-2/);
  assert.doesNotMatch(text, /nextCursor|--cursor/);
});

test("--all json prints { items: [...all] }", async () => {
  let call = 0;
  const { io, stdout } = makeIo({
    env,
    fetch: async () => {
      call += 1;
      if (call === 1) {
        return Response.json({ items: [{ id: "repo-1", name: "r1" }], nextCursor: "c2" });
      }
      return Response.json({ items: [{ id: "repo-2", name: "r2" }] });
    },
  });
  const exitCode = await main(["repo", "list", "--all", "--json"], io);
  assert.equal(exitCode, 0);
  assert.equal(
    stdout(),
    `${JSON.stringify(
      {
        items: [
          { id: "repo-1", name: "r1" },
          { id: "repo-2", name: "r2" },
        ],
      },
      null,
      2,
    )}\n`,
  );
});

test("--all stops at the page cap with a stderr warning and exits 0", async () => {
  let call = 0;
  const { io, stderr, stdout } = makeIo({
    env,
    fetch: async () => {
      call += 1;
      return Response.json({
        items: [{ id: `repo-${call}`, name: `r${call}` }],
        nextCursor: `c${call}`,
      });
    },
  });
  const exitCode = await main(["repo", "list", "--all"], io);
  assert.equal(exitCode, 0);
  assert.equal(call, 20);
  assert.match(stderr(), /warning/i);
  assert.match(stderr(), /20/);
  assert.match(stdout(), /repo-1\b/);
  assert.match(stdout(), /repo-20/);
});

test("--all fails loudly if the server repeats a cursor instead of terminating", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => Response.json({ items: [{ id: "repo-1", name: "r1" }], nextCursor: "same" }),
  });
  const exitCode = await main(["repo", "list", "--all"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /repeated pagination cursor/);
});

test("repo list rejects unexpected positional arguments", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["repo", "list", "extra"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /takes no arguments/);
});

test("no repositories prints a friendly placeholder", async () => {
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json({ items: [] }) });
  const exitCode = await main(["repo", "list"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /\(no repositories\)/);
});
