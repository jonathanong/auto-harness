import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("inventory set sends the file body verbatim", async () => {
  const text = '{"version":5,"repositories":[],"providerAccounts":[]}\n';
  let request;
  const { io, stdout } = makeIo({
    env,
    files: { "/doc.json": text },
    fetch: async (url, init) => {
      request = { url, init };
      return Response.json({ version: 6 });
    },
  });
  const exitCode = await main(["host", "inventory", "set", "host-1", "--file", "/doc.json"], io);
  assert.equal(exitCode, 0);
  assert.equal(request.url, "https://harness.test/api/v1/hosts/host-1/inventory");
  assert.equal(request.init.method, "PUT");
  assert.equal(request.init.body, text);
  assert.match(stdout(), /version 6/);
});

test("inventory set reads from stdin with --file -", async () => {
  const text = '{"version":1,"repositories":[]}';
  let sentBody;
  const { io } = makeIo({
    env,
    stdinText: text,
    fetch: async (url, init) => {
      sentBody = init.body;
      return Response.json({ version: 2 });
    },
  });
  const exitCode = await main(["host", "inventory", "set", "host-1", "--file", "-"], io);
  assert.equal(exitCode, 0);
  assert.equal(sentBody, text);
});

test("inventory set rejects a document with no integer version, exit 2, no request made", async () => {
  const { io, stderr } = makeIo({ env, files: { "/doc.json": '{"repositories":[]}' } });
  const exitCode = await main(["host", "inventory", "set", "host-1", "--file", "/doc.json"], io);
  assert.equal(exitCode, 2);
  const text = stderr();
  assert.match(text, /version/);
  assert.match(text, /inventory get/);
});

test("inventory set rejects a non-integer version", async () => {
  const { io, stderr } = makeIo({
    env,
    files: { "/doc.json": '{"version":"5","repositories":[]}' },
  });
  const exitCode = await main(["host", "inventory", "set", "host-1", "--file", "/doc.json"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /version/);
});

test("inventory set rejects invalid JSON, exit 2, no request made", async () => {
  const { io, stderr } = makeIo({ env, files: { "/doc.json": "{not json" } });
  const exitCode = await main(["host", "inventory", "set", "host-1", "--file", "/doc.json"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /valid JSON/);
});

test("inventory set rejects a non-object document", async () => {
  const { io, stderr } = makeIo({ env, files: { "/doc.json": "[1,2,3]" } });
  const exitCode = await main(["host", "inventory", "set", "host-1", "--file", "/doc.json"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /JSON object/);
});

test("inventory set requires --file", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["host", "inventory", "set", "host-1"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /usage: auto-harness host inventory set/);
});
