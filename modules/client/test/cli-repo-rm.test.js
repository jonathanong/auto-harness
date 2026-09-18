import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

function conflict(dependencies) {
  return Response.json(
    {
      error: {
        code: "CONFLICT",
        message: "cannot delete repository; referenced by other records",
        dependencies,
      },
    },
    { status: 409 },
  );
}

test("repo rm deletes on 204, human output", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      assert.equal(init.method, "DELETE");
      assert.match(url, /\/repositories\/repo-1$/);
      return new Response(null, { status: 204 });
    },
  });
  const exitCode = await main(["repo", "rm", "repo-1"], io);
  assert.equal(exitCode, 0);
  assert.match(stdout(), /repo-1 deleted/);
});

test("repo rm --json prints { deleted: true, id } on success", async () => {
  const { io, stdout } = makeIo({ env, fetch: async () => new Response(null, { status: 204 }) });
  const exitCode = await main(["repo", "rm", "repo-1", "--json"], io);
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout()), { deleted: true, id: "repo-1" });
});

test("a 404 goes through the normal error path, exit 1", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json(
        { error: { code: "NOT_FOUND", message: "repository not found" } },
        { status: 404 },
      ),
  });
  const exitCode = await main(["repo", "rm", "repo-1"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /repository not found/);
  assert.match(stderr(), /NOT_FOUND/);
});

test("409 prints the server message and one hint line per dependency kind, exit 1", async () => {
  const dependencies = [
    { kind: "schedule", id: "sched-1" },
    { kind: "session", id: "sess-1", status: "running" },
    { kind: "session-drain", id: "drain-1", status: "draining" },
    { kind: "host-inventory", id: "host-1" },
    { kind: "worktree", id: "wt-1" },
    { kind: "integration", id: "github-ingress" },
    { kind: "integration", id: "integration-9" },
    { kind: "future-thing", id: "mystery-1" },
  ];
  const { io, stderr } = makeIo({ env, fetch: async () => conflict(dependencies) });
  const exitCode = await main(["repo", "rm", "repo-1"], io);
  assert.equal(exitCode, 1);
  const text = stderr();
  assert.match(text, /cannot delete repository; referenced by other records/);
  assert.match(text, /schedule sched-1: auto-harness api DELETE \/schedules\/sched-1/);
  assert.match(text, /session sess-1 is still running \(status: running\)/);
  assert.match(text, /auto-harness api POST \/sessions\/sess-1\/cancel/);
  assert.match(
    text,
    /session-drain drain-1 \(status: draining\): auto-harness api POST \/repositories\/repo-1\/session-drains\/drain-1\/release/,
  );
  assert.match(text, /host-inventory host-1: auto-harness host repo rm host-1 repo-1/);
  // worktree names the sibling host-inventory's host, not a placeholder.
  assert.match(text, /worktree wt-1: auto-harness host repo rm host-1 repo-1/);
  assert.match(
    text,
    /integration github-ingress: remove this repository's binding from the GitHub ingress configuration/,
  );
  assert.match(text, /integration integration-9: remove or retarget integration integration-9/);
  // Unrecognized kind still prints kind + id plainly.
  assert.match(text, /future-thing mystery-1/);
});

test("409 worktree with no sibling host-inventory falls back to the <hostId> placeholder", async () => {
  const dependencies = [{ kind: "worktree", id: "wt-1" }];
  const { io, stderr } = makeIo({ env, fetch: async () => conflict(dependencies) });
  const exitCode = await main(["repo", "rm", "repo-1"], io);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /worktree wt-1: auto-harness host repo rm <hostId> repo-1/);
});

test("409 --json prints { deleted: false, dependencies, hints }", async () => {
  const dependencies = [{ kind: "schedule", id: "sched-1" }];
  const { io, stdout } = makeIo({ env, fetch: async () => conflict(dependencies) });
  const exitCode = await main(["repo", "rm", "repo-1", "--json"], io);
  assert.equal(exitCode, 1);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.deleted, false);
  assert.deepEqual(parsed.dependencies, dependencies);
  assert.equal(parsed.hints.length, 1);
  assert.match(parsed.hints[0], /schedule sched-1/);
});

test("repo rm requires exactly one positional argument", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["repo", "rm"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness repo rm/);
});
