import assert from "node:assert/strict";
import test from "node:test";

import {
  HarnessDispatchError,
  parseApiOrigin,
  parseHarnessApiOrigin,
} from "../src/actions/index.js";

test("parseApiOrigin accepts an exact https origin, with or without a trailing slash", () => {
  assert.equal(parseApiOrigin("https://harness.test").origin, "https://harness.test");
  assert.equal(parseApiOrigin("https://harness.test/").origin, "https://harness.test");
});

test("parseApiOrigin accepts and strips a trailing /api/v1 suffix", () => {
  assert.equal(parseApiOrigin("https://harness.test/api/v1").origin, "https://harness.test");
  assert.equal(parseApiOrigin("https://harness.test/api/v1/").origin, "https://harness.test");
});

test("parseApiOrigin rejects a missing, non-https, or non-origin URL", () => {
  for (const rawUrl of [
    "not a url",
    "http://harness.test",
    "https://harness.test/path",
    "https://harness.test?query=1",
    "https://user:pass@harness.test",
  ]) {
    assert.throws(
      () => parseApiOrigin(rawUrl),
      (error) => {
        assert.ok(error instanceof HarnessDispatchError);
        return true;
      },
    );
  }
});

test("parseApiOrigin includes a custom fieldName in its error message", () => {
  assert.throws(() => parseApiOrigin("not a url", { fieldName: "server-url" }), /server-url/);
});

test("parseApiOrigin with allowHttp accepts an exact http or https origin", () => {
  assert.equal(
    parseApiOrigin("http://127.0.0.1:4000", { allowHttp: true }).origin,
    "http://127.0.0.1:4000",
  );
  assert.equal(
    parseApiOrigin("https://harness.test", { allowHttp: true }).origin,
    "https://harness.test",
  );
});

test("parseApiOrigin with allowHttp still rejects a path, query, hash, or credentials", () => {
  for (const rawUrl of [
    "http://harness.test/path",
    "http://harness.test?query=1",
    "http://user:pass@harness.test",
  ]) {
    assert.throws(
      () => parseApiOrigin(rawUrl, { allowHttp: true }),
      (error) => {
        assert.ok(error instanceof HarnessDispatchError);
        return true;
      },
    );
  }
});

test("parseHarnessApiOrigin accepts an exact https origin, with or without a trailing slash", () => {
  assert.equal(
    parseHarnessApiOrigin({ HARNESS_URL: "https://harness.test" }).origin,
    "https://harness.test",
  );
  assert.equal(
    parseHarnessApiOrigin({ HARNESS_URL: "https://harness.test/" }).origin,
    "https://harness.test",
  );
});

test("parseHarnessApiOrigin rejects a missing, non-https, or non-origin URL", () => {
  for (const HARNESS_URL of [
    undefined,
    "not a url",
    "http://harness.test",
    "https://harness.test/path",
    "https://harness.test?query=1",
    "https://user:pass@harness.test",
  ]) {
    assert.throws(
      () => parseHarnessApiOrigin({ HARNESS_URL }),
      (error) => {
        assert.ok(error instanceof HarnessDispatchError);
        return true;
      },
    );
  }
});
