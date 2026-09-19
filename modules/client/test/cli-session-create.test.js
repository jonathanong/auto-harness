import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { createHandler, env, refuseFetch } from "./session-create-fixture.js";

const BASE = ["session", "create", "--repo", "repo-1", "--prompt", "do it"];

test("missing --repo is a usage error", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main(["session", "create", "--prompt", "do it", "--command", "c1"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness session create/);
});

test("missing --prompt is a usage error", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main(["session", "create", "--repo", "repo-1", "--command", "c1"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness session create/);
});

test("neither --provider nor --command is a usage error", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main(BASE, io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /exactly one of --provider or --command/);
});

test("both --provider and --command is a usage error", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main([...BASE, "--provider", "p1", "--command", "c1"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /exactly one of --provider or --command/);
});

test("an empty value for a value flag is a usage error", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main([...BASE, "--command", "c1", "--ref="], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--ref was given an empty value/);
});

test("a non-numeric --timeout is a usage error", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main([...BASE, "--command", "c1", "--timeout", "soon"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--timeout must be a positive number/);
});

test("--wait-timeout without --wait is a usage error", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main([...BASE, "--command", "c1", "--wait-timeout", "5"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--wait-timeout requires --wait/);
});

test("a non-numeric --wait-timeout is a usage error", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main([...BASE, "--command", "c1", "--wait", "--wait-timeout", "soon"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--wait-timeout must be a positive number/);
});

test("extra positional arguments are a usage error", async () => {
  const { io, stderr } = makeIo({ env, fetch: refuseFetch });
  const exitCode = await main([...BASE, "--command", "c1", "extra"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness session create/);
});

test("defaults --timeout to 600 seconds when omitted", async () => {
  const capture = {};
  const { io } = makeIo({ env, fetch: createHandler({ commands: [{ id: "c1" }], capture }) });
  const exitCode = await main([...BASE, "--command", "c1"], io);
  assert.equal(exitCode, 0);
  assert.equal(capture.body.timeout, 600);
});

test("an explicit --timeout is forwarded as a number", async () => {
  const capture = {};
  const { io } = makeIo({ env, fetch: createHandler({ commands: [{ id: "c1" }], capture }) });
  await main([...BASE, "--command", "c1", "--timeout", "120"], io);
  assert.equal(capture.body.timeout, 120);
});

test("--ref and --concurrency-id pass straight through", async () => {
  const capture = {};
  const { io } = makeIo({ env, fetch: createHandler({ commands: [{ id: "c1" }], capture }) });
  await main(
    [...BASE, "--command", "c1", "--ref", "refs/heads/feature", "--concurrency-id", "lock-1"],
    io,
  );
  assert.equal(capture.body.ref, "refs/heads/feature");
  assert.equal(capture.body.concurrencyId, "lock-1");
});

test("without --wait, prints the create response immediately (human)", async () => {
  const { io, stdout } = makeIo({ env, fetch: createHandler({ commands: [{ id: "c1" }] }) });
  const exitCode = await main([...BASE, "--command", "c1"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /session-1\s+queued/);
});

test("without --wait, --json prints the full create response", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: createHandler({ commands: [{ id: "c1" }], created: { repositoryId: "repo-1" } }),
  });
  const exitCode = await main([...BASE, "--command", "c1", "--json"], io);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.id, "session-1");
  assert.equal(parsed.repositoryId, "repo-1");
});

test("a server error creating the session (e.g. 400) surfaces as exit 1", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async (url) => {
      if (new URL(url).pathname === "/api/v1/commands") {
        return Response.json({ items: [{ id: "c1" }] });
      }
      return Response.json(
        { error: { code: "VALIDATION_ERROR", message: "bad target" } },
        { status: 400 },
      );
    },
  });
  const exitCode = await main([...BASE, "--command", "c1"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /bad target/);
});
