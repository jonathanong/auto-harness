import assert from "node:assert/strict";
import test from "node:test";

import {
  HarnessDispatchError,
  parseConcurrencyId,
  parseHarnessApiOrigin,
  parseInteger,
  parseMetadata,
  parseRequiredLabels,
  requiredEnvironmentValue,
} from "../src/actions/index.js";

test("requiredEnvironmentValue trims and returns a present value", () => {
  assert.equal(requiredEnvironmentValue({ FOO: "  bar  " }, "FOO"), "bar");
});

test("requiredEnvironmentValue throws HarnessDispatchError when missing or blank", () => {
  for (const environment of [{}, { FOO: "" }, { FOO: "   " }]) {
    assert.throws(
      () => requiredEnvironmentValue(environment, "FOO"),
      (error) => {
        assert.ok(error instanceof HarnessDispatchError);
        assert.equal(error.code, "MISSING_ENVIRONMENT_VALUE");
        assert.match(error.message, /FOO/);
        return true;
      },
    );
  }
});

test("parseInteger returns undefined for absent or empty input", () => {
  assert.equal(parseInteger(undefined, "K", 1), undefined);
  assert.equal(parseInteger("", "K", 1), undefined);
});

test("parseInteger parses a valid integer at or above the minimum", () => {
  assert.equal(parseInteger("5", "K", 1), 5);
  assert.equal(parseInteger("0", "K", 0), 0);
});

test("parseInteger rejects non-integers, negatives, and values below the minimum", () => {
  for (const value of ["abc", "-1", "1.5", "0"]) {
    assert.throws(
      () => parseInteger(value, "K", 1),
      (error) => {
        assert.ok(error instanceof HarnessDispatchError);
        assert.equal(error.code, "INVALID_INTEGER");
        return true;
      },
    );
  }
});

test("parseRequiredLabels returns an empty array for falsy input", () => {
  assert.deepEqual(parseRequiredLabels(undefined), []);
  assert.deepEqual(parseRequiredLabels(""), []);
});

test("parseRequiredLabels parses a JSON array of non-empty strings", () => {
  assert.deepEqual(parseRequiredLabels('["a","b"]'), ["a", "b"]);
});

test("parseRequiredLabels rejects invalid JSON, non-arrays, and non-string entries", () => {
  for (const value of ["not json", "{}", '["a", ""]', '["a", 1]']) {
    assert.throws(
      () => parseRequiredLabels(value),
      (error) => {
        assert.ok(error instanceof HarnessDispatchError);
        assert.equal(error.code, "INVALID_REQUIRED_LABELS");
        return true;
      },
    );
  }
});

test("parseRequiredLabels includes a custom fieldName in its error message", () => {
  assert.throws(() => parseRequiredLabels("not json", "required-labels"), /required-labels/);
});

test("parseConcurrencyId trims and accepts a well-formed id", () => {
  assert.equal(parseConcurrencyId("  abc-123:ok_. "), "abc-123:ok_.");
});

test("parseConcurrencyId rejects blank, oversized, or malformed ids", () => {
  const tooLong = "a".repeat(129);
  for (const value of [undefined, "", "   ", tooLong, "-leading-dash", "has space"]) {
    assert.throws(
      () => parseConcurrencyId(value),
      (error) => {
        assert.ok(error instanceof HarnessDispatchError);
        assert.equal(error.code, "INVALID_CONCURRENCY_ID");
        return true;
      },
    );
  }
});

test("parseMetadata returns an empty object for falsy input", () => {
  assert.deepEqual(parseMetadata(undefined), {});
  assert.deepEqual(parseMetadata(""), {});
});

test("parseMetadata parses a JSON object of scalar values", () => {
  assert.deepEqual(parseMetadata('{"a":"x","b":1,"c":true,"d":null}'), {
    a: "x",
    b: 1,
    c: true,
    d: null,
  });
});

test("parseMetadata rejects invalid JSON, non-objects, and non-scalar values", () => {
  for (const value of ["not json", "[]", "null", '{"a":{}}', '{"a":[1]}']) {
    assert.throws(
      () => parseMetadata(value),
      (error) => {
        assert.ok(error instanceof HarnessDispatchError);
        assert.equal(error.code, "INVALID_METADATA");
        return true;
      },
    );
  }
});

test("parseMetadata rejects a payload exceeding 8192 bytes", () => {
  const big = JSON.stringify({ a: "x".repeat(8200) });
  assert.throws(
    () => parseMetadata(big),
    (error) => {
      assert.ok(error instanceof HarnessDispatchError);
      assert.equal(error.code, "INVALID_METADATA");
      return true;
    },
  );
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
