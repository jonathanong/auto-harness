import assert from "node:assert/strict";
import test from "node:test";

import { isLoopbackHostname, isLoopbackOrigin } from "../src/loopback.js";

test("isLoopbackHostname accepts the full IPv4 loopback block", () => {
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("127.5.9.200"), true);
  assert.equal(isLoopbackHostname("127.255.255.255"), true);
});

test("isLoopbackHostname accepts IPv6 loopback and localhost", () => {
  assert.equal(isLoopbackHostname("[::1]"), true);
  assert.equal(isLoopbackHostname("localhost"), true);
});

test("isLoopbackHostname rejects private-network and public hosts", () => {
  assert.equal(isLoopbackHostname("192.168.1.10"), false);
  assert.equal(isLoopbackHostname("10.0.0.5"), false);
  assert.equal(isLoopbackHostname("172.16.0.5"), false);
  assert.equal(isLoopbackHostname("harness.test"), false);
  assert.equal(isLoopbackHostname("[::2]"), false);
  assert.equal(isLoopbackHostname("128.0.0.1"), false);
});

test("isLoopbackHostname rejects malformed IPv4-shaped hosts", () => {
  assert.equal(isLoopbackHostname("127.0.0"), false);
  assert.equal(isLoopbackHostname("127.0.0.1.1"), false);
  assert.equal(isLoopbackHostname("127.0.0.abc"), false);
});

test("isLoopbackOrigin checks the parsed URL's hostname", () => {
  assert.equal(isLoopbackOrigin("http://127.0.0.1:3000/api/v1"), true);
  assert.equal(isLoopbackOrigin("http://LOCALHOST:3000"), true);
  assert.equal(isLoopbackOrigin("http://[::1]:3000"), true);
  assert.equal(isLoopbackOrigin("http://harness.test"), false);
  assert.equal(isLoopbackOrigin("http://192.168.1.10"), false);
});

test("isLoopbackOrigin treats an unparseable URL as non-loopback", () => {
  assert.equal(isLoopbackOrigin("not a url"), false);
});
