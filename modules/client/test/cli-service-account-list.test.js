import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

const rawAccount = {
  id: "svc-1",
  kind: "service-account",
  name: "ci",
  role: "operator",
  boundHostId: "host-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  capabilities: ["dispatch:sessions"],
  apiKeyHash: "should-not-print",
  passwordHash: "should-not-print-either",
};

test("service-account list prints one line per account, human format", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ items: [rawAccount], nextCursor: null }),
  });
  const exitCode = await main(["service-account", "list"], io);
  assert.equal(exitCode, 0);
  const text = stdout();
  assert.match(text, /svc-1\s+ci\s+operator\s+host-1\s+2026-01-01T00:00:00\.000Z/);
  assert.ok(!text.includes("should-not-print"));
});

test("service-account list --json still allowlists — no field outside the allowlist leaks", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ items: [rawAccount], nextCursor: null }),
  });
  const exitCode = await main(["service-account", "list", "--json"], io);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.items.length, 1);
  const item = parsed.items[0];
  assert.deepEqual(Object.keys(item).toSorted(), [
    "boundHostId",
    "capabilities",
    "createdAt",
    "id",
    "kind",
    "name",
    "role",
  ]);
  assert.ok(!("apiKeyHash" in item));
  assert.ok(!("passwordHash" in item));
});

test("--all follows nextCursor and allowlists every page", async () => {
  let call = 0;
  const { io, stdout } = makeIo({
    env,
    fetch: async () => {
      call += 1;
      if (call === 1) {
        return Response.json({ items: [{ ...rawAccount, id: "svc-1" }], nextCursor: "c2" });
      }
      return Response.json({ items: [{ ...rawAccount, id: "svc-2" }], nextCursor: null });
    },
  });
  const exitCode = await main(["service-account", "list", "--all", "--json"], io);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout());
  assert.deepEqual(
    parsed.items.map((item) => item.id),
    ["svc-1", "svc-2"],
  );
  assert.ok(!parsed.items.some((item) => "apiKeyHash" in item));
});

test("a nextCursor prints a hint unless --all", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ items: [], nextCursor: "abc123" }),
  });
  const exitCode = await main(["service-account", "list"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /abc123/);
});

test("service-account list rejects unexpected positional arguments", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["service-account", "list", "extra"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /takes no arguments/);
});

test("no service accounts prints a friendly placeholder", async () => {
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json({ items: [] }) });
  const exitCode = await main(["service-account", "list"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /\(no service accounts\)/);
});
