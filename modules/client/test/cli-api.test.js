import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("api GET strips a leading /api/v1 and pretty-prints the response", async () => {
  const calls = [];
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ items: [] });
    },
  });
  const exitCode = await main(["api", "GET", "/api/v1/hosts"], io);
  assert.equal(exitCode, 0);
  assert.equal(calls[0].url, "https://harness.test/api/v1/hosts");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(stdout(), `${JSON.stringify({ items: [] }, null, 2)}\n`);
});

test("api accepts a path with no /api/v1 prefix unchanged", async () => {
  const calls = [];
  const { io } = makeIo({
    env,
    fetch: async (url) => {
      calls.push(url);
      return Response.json({});
    },
  });
  await main(["api", "get", "/hosts"], io);
  assert.equal(calls[0], "https://harness.test/api/v1/hosts");
});

test("api POST sends --body as the JSON request body", async () => {
  let request;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url, init) => {
      request = { url, init };
      return Response.json({ id: "created" }, { status: 201 });
    },
  });
  const exitCode = await main(["api", "POST", "/hosts", "--body", '{"name":"h1"}'], io);
  assert.equal(exitCode, 0);
  assert.equal(request.url, "https://harness.test/api/v1/hosts");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.body, JSON.stringify({ name: "h1" }));
  assert.equal(stdout(), `${JSON.stringify({ id: "created" }, null, 2)}\n`);
});

test("api reads --body-file from disk", async () => {
  let request;
  const { io } = makeIo({
    env,
    files: { "/body.json": '{"name":"h2"}' },
    fetch: async (url, init) => {
      request = init;
      return Response.json({}, { status: 200 });
    },
  });
  const exitCode = await main(["api", "POST", "/hosts", "--body-file", "/body.json"], io);
  assert.equal(exitCode, 0);
  assert.equal(request.body, JSON.stringify({ name: "h2" }));
});

test("api reads --body-file - from stdin", async () => {
  let request;
  const { io } = makeIo({
    env,
    stdinText: '{"name":"h3"}',
    fetch: async (url, init) => {
      request = init;
      return Response.json({}, { status: 200 });
    },
  });
  const exitCode = await main(["api", "POST", "/hosts", "--body-file", "-"], io);
  assert.equal(exitCode, 0);
  assert.equal(request.body, JSON.stringify({ name: "h3" }));
});

test("api prints nothing for a 204 response", async () => {
  const { io, stdout } = makeIo({ env, fetch: async () => new Response(null, { status: 204 }) });
  const exitCode = await main(["api", "DELETE", "/hosts/h1"], io);
  assert.equal(exitCode, 0);
  assert.equal(stdout(), "");
});

test("api rejects both --body and --body-file with a usage error", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["api", "POST", "/hosts", "--body", "{}", "--body-file", "-"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /mutually exclusive/);
});

test("api rejects invalid JSON in --body with a usage error, exit 2", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["api", "POST", "/hosts", "--body", "{not json"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /valid JSON/);
});

test("api requires both a method and a path", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["api", "GET"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness api/);
});

test("api prints an error response's details fields beyond code/message", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "HAS_DEPENDENCIES",
            message: "cannot delete: still referenced",
            dependencies: [{ kind: "session", id: "s1" }],
          },
        },
        { status: 409 },
      ),
  });
  const exitCode = await main(["api", "DELETE", "/repositories/r1"], io);
  assert.equal(exitCode, 1);
  const text = stderr();
  assert.match(text, /error: cannot delete: still referenced \(HTTP 409, HAS_DEPENDENCIES\)/);
  assert.match(text, /"dependencies"/);
  assert.match(text, /"s1"/);
});
