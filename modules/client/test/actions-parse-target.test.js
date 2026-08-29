import assert from "node:assert/strict";
import test from "node:test";

import {
  HarnessDispatchError,
  TARGET_SPEC_KEYS,
  parseHarnessFallbacks,
  parseHarnessTarget,
} from "../src/actions/index.js";

test("TARGET_SPEC_KEYS lists the four target-spec fields", () => {
  assert.deepEqual(TARGET_SPEC_KEYS, ["providerId", "providerName", "commandId", "commandName"]);
});

test("parseHarnessTarget accepts each of the four target-spec shapes", () => {
  assert.deepEqual(parseHarnessTarget('{"providerId":"p1"}'), { providerId: "p1" });
  assert.deepEqual(parseHarnessTarget('{"providerName":"claude"}'), { providerName: "claude" });
  assert.deepEqual(parseHarnessTarget('{"commandId":"c1"}'), { commandId: "c1" });
  assert.deepEqual(parseHarnessTarget('{"commandName":"claude-print"}'), {
    commandName: "claude-print",
  });
});

test("parseHarnessTarget rejects invalid JSON", () => {
  assert.throws(
    () => parseHarnessTarget("not json"),
    (error) => {
      assert.ok(error instanceof HarnessDispatchError);
      assert.equal(error.code, "INVALID_TARGET");
      return true;
    },
  );
});

test("parseHarnessTarget rejects a non-object, an unknown field, zero fields, and more than one field", () => {
  for (const value of [
    "[]",
    "null",
    '"providerId"',
    '{"unknown":"x"}',
    "{}",
    '{"providerId":"p1","commandId":"c1"}',
  ]) {
    assert.throws(
      () => parseHarnessTarget(value),
      (error) => {
        assert.ok(error instanceof HarnessDispatchError);
        assert.equal(error.code, "INVALID_TARGET");
        return true;
      },
    );
  }
});

test("parseHarnessTarget rejects an empty or non-string field value", () => {
  for (const value of ['{"providerId":""}', '{"providerId":1}']) {
    assert.throws(
      () => parseHarnessTarget(value),
      (error) => {
        assert.ok(error instanceof HarnessDispatchError);
        assert.equal(error.code, "INVALID_TARGET");
        return true;
      },
    );
  }
});

test("parseHarnessFallbacks returns an empty array for blank input", () => {
  assert.deepEqual(parseHarnessFallbacks(undefined), []);
  assert.deepEqual(parseHarnessFallbacks(""), []);
  assert.deepEqual(parseHarnessFallbacks("   "), []);
});

test("parseHarnessFallbacks parses an array of target-spec objects in order", () => {
  assert.deepEqual(parseHarnessFallbacks('[{"providerId":"p1"},{"commandName":"c2"}]'), [
    { providerId: "p1" },
    { commandName: "c2" },
  ]);
});

test("parseHarnessFallbacks rejects invalid JSON or a non-array", () => {
  for (const value of ["not json", '{"providerId":"p1"}']) {
    assert.throws(
      () => parseHarnessFallbacks(value),
      (error) => {
        assert.ok(error instanceof HarnessDispatchError);
        assert.equal(error.code, "INVALID_FALLBACKS");
        return true;
      },
    );
  }
});

test("parseHarnessFallbacks rejects an invalid entry and names its index", () => {
  assert.throws(
    () => parseHarnessFallbacks('[{"providerId":"p1"},{"bad":"x"}]'),
    /HARNESS_FALLBACKS\[1\]/,
  );
});

test("parseHarnessTarget includes a custom fieldName in its error message", () => {
  assert.throws(() => parseHarnessTarget("not json", "target"), /target/);
});

test("parseHarnessFallbacks includes a custom fieldName in its error message and index", () => {
  assert.throws(
    () => parseHarnessFallbacks('[{"providerId":"p1"},{"bad":"x"}]', "fallbacks"),
    /fallbacks\[1\]/,
  );
});
