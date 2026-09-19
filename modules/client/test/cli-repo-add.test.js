import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

function createdRepository(overrides) {
  return {
    id: "repo-1",
    name: "org/repo",
    url: "https://github.com/org/repo",
    defaultBranch: "main",
    admissionState: "active",
    admissionStateChangedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("repo add posts name/url and prints the unwrapped created record as one line", async () => {
  let body;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      assert.equal(init.method, "POST");
      assert.match(url, /\/repositories$/);
      body = JSON.parse(init.body);
      return Response.json(createdRepository(), { status: 201 });
    },
  });
  const exitCode = await main(
    ["repo", "add", "--name", "org/repo", "--url", "https://github.com/org/repo"],
    io,
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(body, { name: "org/repo", url: "https://github.com/org/repo" });
  assert.equal(stdout(), "repo-1  org/repo\n");
});

test("repo add --default-branch is forwarded in the request body", async () => {
  let body;
  const { io } = makeIo({
    env,
    fetch: async (url, init) => {
      body = JSON.parse(init.body);
      return Response.json(createdRepository({ defaultBranch: "develop" }), { status: 201 });
    },
  });
  const exitCode = await main(
    [
      "repo",
      "add",
      "--name",
      "org/repo",
      "--url",
      "https://github.com/org/repo",
      "--default-branch",
      "develop",
    ],
    io,
  );
  assert.equal(exitCode, 0);
  assert.equal(body.defaultBranch, "develop");
});

test("repo add --json prints the created record verbatim, unwrapped", async () => {
  const repo = createdRepository();
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json(repo, { status: 201 }),
  });
  const exitCode = await main(
    ["repo", "add", "--name", "org/repo", "--url", "https://github.com/org/repo", "--json"],
    io,
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout()), repo);
});

test("repo add requires --name and --url", async () => {
  const { io, stderr } = makeIo({ env });
  for (const argv of [
    ["repo", "add", "--url", "https://github.com/org/repo"],
    ["repo", "add", "--name", "org/repo"],
    ["repo", "add"],
  ]) {
    const exitCode = await main(argv, io);
    assert.equal(exitCode, 2);
    assert.match(stderr(), /usage: auto-harness repo add/);
  }
});

test("repo add rejects an empty --name value as a usage error", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(
    ["repo", "add", "--name=", "--url", "https://github.com/org/repo"],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness repo add/);
});

test("repo add rejects extra positional arguments", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(
    ["repo", "add", "extra", "--name", "org/repo", "--url", "https://github.com/org/repo"],
    io,
  );
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness repo add/);
});

test("a server-side validation error surfaces through the normal error path, exit 1", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json(
        {
          error: { code: "VALIDATION_ERROR", message: "repository name already in use: org/repo" },
        },
        { status: 400 },
      ),
  });
  const exitCode = await main(
    ["repo", "add", "--name", "org/repo", "--url", "https://github.com/org/repo"],
    io,
  );
  assert.equal(exitCode, 1);
  assert.match(stderr(), /repository name already in use: org\/repo/);
  assert.match(stderr(), /VALIDATION_ERROR/);
});
