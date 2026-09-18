import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("host list prints one line per host, human format", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () =>
      Response.json({
        items: [
          { hostId: "h1", online: true, draining: false },
          { hostId: "h2", online: false, draining: true },
        ],
      }),
  });
  const exitCode = await main(["host", "list"], io);
  assert.equal(exitCode, 0);
  const text = stdout();
  assert.match(text, /h1\s+online/);
  assert.match(text, /h2\s+offline\s+draining/);
});

test("host list --json prints the raw page", async () => {
  const page = { items: [{ hostId: "h1", online: true, draining: false }], nextCursor: null };
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json(page) });
  const exitCode = await main(["host", "list", "--json"], io);
  assert.equal(exitCode, 0);
  assert.equal(stdout(), `${JSON.stringify(page, null, 2)}\n`);
});

test("--online reaches the query string", async () => {
  let seenUrl;
  const { io } = makeIo({
    env,
    fetch: async (url) => {
      seenUrl = url;
      return Response.json({ items: [] });
    },
  });
  await main(["host", "list", "--online"], io);
  assert.match(seenUrl, /online=online/);
});

test("--offline reaches the query string", async () => {
  let seenUrl;
  const { io } = makeIo({
    env,
    fetch: async (url) => {
      seenUrl = url;
      return Response.json({ items: [] });
    },
  });
  await main(["host", "list", "--offline"], io);
  assert.match(seenUrl, /online=offline/);
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
  await main(["host", "list", "--limit", "5", "--cursor", "abc"], io);
  assert.match(seenUrl, /limit=5/);
  assert.match(seenUrl, /cursor=abc/);
});

test("--online and --offline together is a usage error, exit 2", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["host", "list", "--online", "--offline"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /mutually exclusive/);
});

test("a nextCursor prints a hint unless --all", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ items: [], nextCursor: "abc123" }),
  });
  const exitCode = await main(["host", "list"], io);
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
        return Response.json({
          items: [{ hostId: "h1", online: true, draining: false }],
          nextCursor: "c2",
        });
      }
      return Response.json({ items: [{ hostId: "h2", online: true, draining: false }] });
    },
  });
  const exitCode = await main(["host", "list", "--all"], io);
  assert.equal(exitCode, 0);
  assert.equal(call, 2);
  const text = stdout();
  assert.match(text, /h1/);
  assert.match(text, /h2/);
  assert.doesNotMatch(text, /nextCursor|--cursor/);
});

test("--all json prints { items: [...all] }", async () => {
  let call = 0;
  const { io, stdout } = makeIo({
    env,
    fetch: async () => {
      call += 1;
      if (call === 1) {
        return Response.json({
          items: [{ hostId: "h1", online: true, draining: false }],
          nextCursor: "c2",
        });
      }
      return Response.json({ items: [{ hostId: "h2", online: true, draining: false }] });
    },
  });
  const exitCode = await main(["host", "list", "--all", "--json"], io);
  assert.equal(exitCode, 0);
  assert.equal(
    stdout(),
    `${JSON.stringify(
      {
        items: [
          { hostId: "h1", online: true, draining: false },
          { hostId: "h2", online: true, draining: false },
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
        items: [{ hostId: `h${call}`, online: true, draining: false }],
        nextCursor: `c${call}`,
      });
    },
  });
  const exitCode = await main(["host", "list", "--all"], io);
  assert.equal(exitCode, 0);
  assert.equal(call, 20);
  assert.match(stderr(), /warning/i);
  assert.match(stderr(), /20/);
  assert.match(stdout(), /h1/);
  assert.match(stdout(), /h20/);
});

test("--all fails loudly if the server repeats a cursor instead of terminating", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json({
        items: [{ hostId: "h1", online: true, draining: false }],
        nextCursor: "same",
      }),
  });
  const exitCode = await main(["host", "list", "--all"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /repeated pagination cursor/);
});

test("host list rejects unexpected positional arguments", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["host", "list", "extra"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /takes no arguments/);
});
