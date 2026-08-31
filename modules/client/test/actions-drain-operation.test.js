import assert from "node:assert/strict";
import test from "node:test";

import { isHarnessDrainOperation } from "../src/actions/index.js";

test("accepts start-drain, get-drain, wait-for-drain, and release-drain", () => {
  assert.equal(isHarnessDrainOperation("start-drain"), true);
  assert.equal(isHarnessDrainOperation("get-drain"), true);
  assert.equal(isHarnessDrainOperation("wait-for-drain"), true);
  assert.equal(isHarnessDrainOperation("release-drain"), true);
});

test("rejects unknown or missing values", () => {
  assert.equal(isHarnessDrainOperation("release"), false);
  assert.equal(isHarnessDrainOperation(""), false);
  assert.equal(isHarnessDrainOperation(undefined), false);
});
