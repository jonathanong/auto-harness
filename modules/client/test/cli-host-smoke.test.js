import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";
import { BASE_ARGV, env, HOST_ID, makeSmokeFetch, REPO_PATH } from "./host-smoke-fixture.js";

test("happy path: create, attach, run, teardown, in order, exit 0", async () => {
  const { fetch, calls, state } = makeSmokeFetch();
  const { io, stdout, stderr } = makeIo({ env, fetch });
  const exitCode = await main(BASE_ARGV, io);
  assert.equal(exitCode, 0);

  // Step order: create -> attach -> create session -> poll -> logs -> detach -> delete.
  assert.deepEqual(
    calls.filter((call) => !call.startsWith("GET /api/v1/providers")),
    [
      "POST /api/v1/repositories",
      "GET /api/v1/hosts/host-1/inventory",
      "PUT /api/v1/hosts/host-1/inventory",
      "POST /api/v1/sessions",
      "GET /api/v1/sessions/session-1",
      "GET /api/v1/sessions/session-1/logs",
      "GET /api/v1/hosts/host-1/inventory",
      "PUT /api/v1/hosts/host-1/inventory",
      "DELETE /api/v1/repositories/repo-1",
    ],
  );
  assert.deepEqual(state.inventory.repositories, []); // detached again by teardown
  assert.match(stdout(), /PASS {2}claude/);
  assert.match(stdout(), /1\/1 providers passed/);
  assert.match(stdout(), /teardown ok/);
  assert.match(stdout(), /host smoke PASSED for host host-1/);
  assert.match(stderr(), /ok {2}created repository repo-1/);
  assert.match(stderr(), /ok {2}attached repository repo-1 to host host-1 at \/repos\/x/);
  assert.match(stderr(), /ok {2}provider claude: PASS/);
});

test("the created repository's url is an inert, obviously-fake https placeholder", async () => {
  let capturedBody;
  const { fetch } = makeSmokeFetch({
    createRepository: (body) => {
      capturedBody = body;
      return Response.json({ id: "repo-1", name: body.name, url: body.url, defaultBranch: "main" });
    },
  });
  const { io } = makeIo({ env, fetch });
  await main(BASE_ARGV, io);
  assert.match(capturedBody.name, /^smoke-[0-9a-f]+$/);
  assert.equal(capturedBody.url, `https://example.test/${capturedBody.name}.git`);
});

test("--json prints a structured result", async () => {
  const { fetch } = makeSmokeFetch();
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main([...BASE_ARGV, "--json"], io);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.hostId, HOST_ID);
  assert.equal(parsed.repositoryId, "repo-1");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.providers.length, 1);
  assert.equal(parsed.providers[0].pass, true);
  assert.equal(parsed.providers[0].provider, "claude");
  assert.equal(parsed.teardown.ok, true);
  assert.equal(parsed.teardown.detached, true);
  assert.equal(parsed.teardown.repositoryDeleted, true);
});

test("attaches one worktree, smoke-1, at <repo-path>/.worktrees/smoke-1", async () => {
  let putBody;
  const { fetch } = makeSmokeFetch({
    putInventory: (body, inventory) => {
      putBody ??= body; // first PUT is the attach; the second (teardown) removes it again
      return Response.json({ ...body, version: (inventory.version ?? 0) + 1 });
    },
  });
  const { io } = makeIo({ env, fetch });
  await main(BASE_ARGV, io);
  assert.deepEqual(putBody.repositories[0].worktrees, [
    { id: "smoke-1", name: "smoke-1", path: "/repos/x/.worktrees/smoke-1", labels: [] },
  ]);
});

for (const argv of [
  ["host", "smoke"],
  ["host", "smoke", HOST_ID],
  ["host", "smoke", HOST_ID, "--repo-path", REPO_PATH],
  ["host", "smoke", HOST_ID, "--provider", "claude"],
  ["host", "smoke", HOST_ID, "extra", "--repo-path", REPO_PATH, "--provider", "claude"],
]) {
  test(`usage error for ${JSON.stringify(argv)}`, async () => {
    const { io, stderr } = makeIo({ env });
    const exitCode = await main(argv, io);
    assert.equal(exitCode, 2);
    assert.match(stderr(), /usage: auto-harness host smoke/);
  });
}

test("multiple --provider flags run in the given order", async () => {
  const { fetch, state } = makeSmokeFetch({
    providers: [
      { id: "prov-1", name: "claude" },
      { id: "prov-2", name: "codex" },
    ],
  });
  const { io, stdout } = makeIo({ env, fetch });
  const exitCode = await main(
    [
      "host",
      "smoke",
      HOST_ID,
      "--repo-path",
      REPO_PATH,
      "--provider",
      "claude",
      "--provider",
      "codex",
    ],
    io,
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(
    [...state.sessions.values()].map((session) => session.target),
    [{ providerId: "prov-1" }, { providerId: "prov-2" }],
  );
  assert.match(stdout(), /PASS {2}claude/);
  assert.match(stdout(), /PASS {2}codex/);
  assert.match(stdout(), /2\/2 providers passed/);
});

test("--timeout must be a positive number", async () => {
  const { io, stderr } = makeIo({ env });
  for (const timeout of ["0", "-5", "nope"]) {
    const exitCode = await main([...BASE_ARGV, "--timeout", timeout], io);
    assert.equal(exitCode, 2);
    assert.match(stderr(), /--timeout must be a positive number/);
  }
});

test("--timeout above the session timeout ceiling is a usage error", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main([...BASE_ARGV, "--timeout", String(8 * 24 * 60 * 60)], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /--timeout must be at most/);
});
