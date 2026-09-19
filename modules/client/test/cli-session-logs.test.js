import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

function logItem(n) {
  return { timestamp: `2026-01-01T00:00:0${n}.000Z`, stream: "stdout", content: `line ${n}` };
}

test("prints one line per log record, human format", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ items: [logItem(1), logItem(2)] }),
  });
  const exitCode = await main(["session", "logs", "session-1"], io);
  assert.equal(exitCode, 0);
  const text = stdout();
  assert.match(text, /2026-01-01T00:00:01\.000Z\s+\[stdout\]\s+line 1/);
  assert.match(text, /2026-01-01T00:00:02\.000Z\s+\[stdout\]\s+line 2/);
});

test("an empty page prints a friendly placeholder and no hint", async () => {
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json({ items: [] }) });
  const exitCode = await main(["session", "logs", "session-1"], io);
  assert.equal(exitCode, 0);
  assert.equal(stdout(), "(no logs)\n");
});

test("--limit and --cursor reach the query string as limit/since", async () => {
  let seenUrl;
  const { io } = makeIo({
    env,
    fetch: async (url) => {
      seenUrl = url;
      return Response.json({ items: [] });
    },
  });
  await main(
    ["session", "logs", "session-1", "--limit", "5", "--cursor", "2026-01-01T00:00:00Z"],
    io,
  );
  assert.match(seenUrl, /limit=5/);
  assert.match(seenUrl, /since=2026-01-01T00%3A00%3A00Z/);
});

test("a full page (items.length === limit) prints a continuation hint", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ items: [logItem(1), logItem(2)] }),
  });
  const exitCode = await main(["session", "logs", "session-1", "--limit", "2"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /more logs may be available; pass --cursor 2026-01-01T00:00:02\.000Z/);
});

test("a short page (fewer items than the limit) prints no hint", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ items: [logItem(1)] }),
  });
  const exitCode = await main(["session", "logs", "session-1", "--limit", "5"], io);
  assert.equal(exitCode, 0);
  assert.doesNotMatch(stdout(), /more logs may be available/);
});

test("--json prints the raw page, with no synthetic cursor hint", async () => {
  const page = { items: [logItem(1)] };
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json(page) });
  const exitCode = await main(["session", "logs", "session-1", "--json"], io);
  assert.equal(exitCode, 0);
  assert.equal(stdout(), `${JSON.stringify(page, null, 2)}\n`);
});

test("a non-integer --limit is a usage error", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["session", "logs", "session-1", "--limit", "abc"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--limit must be a positive integer/);
});

test("an empty --cursor value is a usage error", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["session", "logs", "session-1", "--cursor="], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--cursor was given an empty value/);
});

test("missing sessionId is a usage error", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["session", "logs"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness session logs/);
});

test("extra positional arguments are a usage error", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["session", "logs", "session-1", "extra"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness session logs/);
});

test("a sessionId of . or .. is rejected before any request", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("fetch must not be called");
    },
  });
  const exitCode = await main(["session", "logs", ".."], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /sessionId must not be "\."/);
});
