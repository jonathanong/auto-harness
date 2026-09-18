import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test", HARNESS_API_KEY: "test-key" };

// makeIo's default fetch throws, so a request reaching the network would exit 1 rather than 2.
// Asserting exit 2 therefore also proves nothing was sent.
async function runRejected(args) {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["api", ...args], io);
  return { exitCode, stderr: stderr() };
}

async function runAccepted(args) {
  const calls = [];
  const { io } = makeIo({
    env,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true });
    },
  });
  const exitCode = await main(["api", ...args], io);
  return { exitCode, calls };
}

for (const method of ["G ET", "TRACE", "CONNECT", "FETCH", ""]) {
  test(`api rejects the method ${JSON.stringify(method)} as a usage error before any request`, async () => {
    const { exitCode, stderr } = await runRejected([method, "/hosts"]);
    assert.equal(exitCode, 2);
    assert.match(stderr, method === "" ? /usage: auto-harness api/ : /unsupported HTTP method/);
  });
}

test("api accepts a lowercase method and sends it uppercased", async () => {
  const { exitCode, calls } = await runAccepted(["patch", "/hosts", "--body", "{}"]);
  assert.equal(exitCode, 0);
  assert.equal(calls[0].init.method, "PATCH");
});

// Every form the WHATWG URL parser resolves as "." or "..": literal, percent-encoded in either
// case, mixed, and backslash-separated (an https URL treats `\` as `/`).
for (const path of [
  "/api/v1/../health",
  "/../../health",
  "/hosts/./x",
  "/%2e%2e/health",
  "/%2E%2E/health",
  "/.%2e/health",
  "/%2e./health",
  "/%2e/hosts",
  "/..\\health",
  "\\..\\..\\health",
]) {
  test(`api rejects the dot-segment path ${JSON.stringify(path)} before any request`, async () => {
    const { exitCode, stderr } = await runRejected(["GET", path]);
    assert.equal(exitCode, 2);
    assert.match(stderr, /must not contain "\." or "\.\." segments/);
  });
}

test("api still allows dots that are not whole segments, and dots in the query string", async () => {
  for (const path of ["/hosts/..foo", "/hosts/v1.2", "/hosts?q=..", "/hosts?next=../x"]) {
    const { exitCode, calls } = await runAccepted(["GET", path]);
    assert.equal(exitCode, 0, path);
    assert.equal(calls.length, 1, path);
  }
});
