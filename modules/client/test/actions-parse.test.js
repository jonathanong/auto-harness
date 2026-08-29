import assert from "node:assert/strict";
import test from "node:test";

import {
  HarnessDispatchError,
  parseConcurrencyId,
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

test("parseConcurrencyId returns undefined for blank input when optional", () => {
  assert.equal(parseConcurrencyId(undefined, { optional: true }), undefined);
  assert.equal(parseConcurrencyId("", { optional: true }), undefined);
  assert.equal(parseConcurrencyId("   ", { optional: true }), undefined);
});

test("parseConcurrencyId includes a custom fieldName in its error message", () => {
  assert.throws(
    () => parseConcurrencyId(undefined, { fieldName: "concurrency-id" }),
    /concurrency-id/,
  );
});

test("parseConcurrencyId with allowAnyCharacters accepts characters the default charset rejects", () => {
  assert.equal(
    parseConcurrencyId("refs/heads/feature/foo", { allowAnyCharacters: true }),
    "refs/heads/feature/foo",
  );
  assert.equal(parseConcurrencyId("has space", { allowAnyCharacters: true }), "has space");
});

test("parseConcurrencyId with allowAnyCharacters still rejects blank input and enforces a byte limit", () => {
  assert.throws(
    () => parseConcurrencyId(undefined, { allowAnyCharacters: true }),
    (error) => {
      assert.ok(error instanceof HarnessDispatchError);
      assert.equal(error.code, "INVALID_CONCURRENCY_ID");
      return true;
    },
  );
  const tooLong = "a".repeat(2_049);
  assert.throws(
    () => parseConcurrencyId(tooLong, { allowAnyCharacters: true }),
    (error) => {
      assert.ok(error instanceof HarnessDispatchError);
      assert.equal(error.code, "INVALID_CONCURRENCY_ID");
      assert.match(error.message, /2048 bytes/);
      return true;
    },
  );
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

test("parseMetadata includes a custom fieldName in its error message", () => {
  assert.throws(() => parseMetadata("not json", "metadata"), /metadata/);
});
