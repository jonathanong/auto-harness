import assert from "node:assert/strict";
import test from "node:test";

import { AutoHarnessClient } from "../src/index.js";

const successfulFetch = async () => Response.json({});

test("rejects a non-https baseUrl when apiKey is set", () => {
  assert.throws(
    () =>
      new AutoHarnessClient({
        baseUrl: "http://harness.test",
        apiKey: "key",
        fetch: successfulFetch,
      }),
    /baseUrl must use https when apiKey is set/,
  );
});

for (const baseUrl of ["http://127.0.0.1:3000", "http://[::1]:3000", "http://localhost:3000"]) {
  test(`allows a loopback baseUrl (${baseUrl}) with apiKey when allowInsecureHttp is true`, () => {
    const client = new AutoHarnessClient({
      baseUrl,
      apiKey: "key",
      fetch: successfulFetch,
      allowInsecureHttp: true,
    });
    assert.equal(client.baseUrl, baseUrl);
  });
}

test("rejects a non-loopback baseUrl with apiKey even when allowInsecureHttp is true", () => {
  assert.throws(
    () =>
      new AutoHarnessClient({
        baseUrl: "http://harness.test",
        apiKey: "key",
        fetch: successfulFetch,
        allowInsecureHttp: true,
      }),
    /baseUrl must use https when apiKey is set/,
  );
});

test("rejects a private-network baseUrl with apiKey even when allowInsecureHttp is true", () => {
  assert.throws(
    () =>
      new AutoHarnessClient({
        baseUrl: "http://192.168.1.10:3000",
        apiKey: "key",
        fetch: successfulFetch,
        allowInsecureHttp: true,
      }),
    /baseUrl must use https when apiKey is set/,
  );
});

test("allows a non-https baseUrl without apiKey regardless of allowInsecureHttp", () => {
  assert.doesNotThrow(
    () => new AutoHarnessClient({ baseUrl: "http://harness.test", fetch: successfulFetch }),
  );
});
