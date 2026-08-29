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

test("allows a non-https baseUrl with apiKey when allowInsecureHttp is true", () => {
  const client = new AutoHarnessClient({
    baseUrl: "http://harness.test",
    apiKey: "key",
    fetch: successfulFetch,
    allowInsecureHttp: true,
  });
  assert.equal(client.baseUrl, "http://harness.test");
});

test("allows a non-https baseUrl without apiKey regardless of allowInsecureHttp", () => {
  assert.doesNotThrow(
    () => new AutoHarnessClient({ baseUrl: "http://harness.test", fetch: successfulFetch }),
  );
});
