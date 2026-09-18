import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { pathSegment } from "../src/cli/path-segment.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test", HARNESS_API_KEY: "test-key" };

test("pathSegment rejects . and .. — encodeURIComponent leaves dots alone", () => {
  assert.equal(encodeURIComponent(".."), "..");
  for (const id of [".", ".."]) {
    assert.throws(() => pathSegment(id, "hostId"), /hostId must not be "\." or "\.\."/);
  }
});

test("pathSegment encodes everything else, and a percent-encoded dot cannot become a dot segment", () => {
  assert.equal(pathSegment("jongs-mac-studio", "hostId"), "jongs-mac-studio");
  assert.equal(pathSegment("a/b", "hostId"), "a%2Fb");
  assert.equal(pathSegment("..foo", "hostId"), "..foo");
  // `%2e%2e` would be a dot segment to the URL parser; encoded it is `%252e%252e`, which is not.
  assert.equal(pathSegment("%2e%2e", "hostId"), "%252e%252e");
  assert.equal(
    new URL(`https://h.test/api/v1/hosts/%252e%252e/inventory`).pathname,
    "/api/v1/hosts/%252e%252e/inventory",
  );
});

// makeIo's default fetch throws, so a request that escaped would exit 1, not 2.
for (const [label, argv] of [
  ["host inventory get ..", ["host", "inventory", "get", ".."]],
  ["host inventory get .", ["host", "inventory", "get", "."]],
  ["host inventory set ..", ["host", "inventory", "set", "..", "--file", "doc.json"]],
  ["host repo rm ..", ["host", "repo", "rm", "..", "repo-1"]],
]) {
  test(`${label} is a usage error and sends nothing`, async () => {
    const { io, stderr } = makeIo({ env, files: { "doc.json": '{"version":1}' } });
    assert.equal(await main(argv, io), 2);
    assert.match(stderr(), /hostId must not be "\." or "\.\."/);
  });
}

test("host inventory get sends a percent-encoded dot id double-encoded, not resolved", async () => {
  const urls = [];
  const { io } = makeIo({
    env,
    fetch: async (url) => {
      urls.push(url);
      return Response.json({ version: 1, repositories: [], providerAccounts: [] });
    },
  });
  assert.equal(await main(["host", "inventory", "get", "%2e%2e"], io), 0);
  assert.equal(urls[0], "https://harness.test/api/v1/hosts/%252e%252e/inventory");
});
