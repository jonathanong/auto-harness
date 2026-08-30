import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeOutputs } from "../src/actions/index.js";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "auto-harness-write-outputs-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const result = { id: "session-1", url: "https://harness.test/sessions/session-1", created: true };

test("appends session-id, session-url, and created to GITHUB_OUTPUT when set", () => {
  withTempDir((dir) => {
    const outputPath = join(dir, "output");
    writeFileSync(outputPath, "");
    writeOutputs({ GITHUB_OUTPUT: outputPath }, result);
    assert.equal(
      readFileSync(outputPath, "utf8"),
      "session-id=session-1\nsession-url=https://harness.test/sessions/session-1\ncreated=true\n",
    );
  });
});

test("does nothing to GITHUB_OUTPUT when it is unset", () => {
  assert.doesNotThrow(() => writeOutputs({}, result));
});

test("appends a summary table to GITHUB_STEP_SUMMARY including the resolved route", () => {
  withTempDir((dir) => {
    const summaryPath = join(dir, "summary");
    writeFileSync(summaryPath, "");
    writeOutputs(
      { GITHUB_STEP_SUMMARY: summaryPath, HARNESS_CONCURRENCY_ID: "concurrency-1" },
      result,
      [{ providerId: "prov-1" }, { commandName: "claude-print" }],
    );
    const summary = readFileSync(summaryPath, "utf8");
    assert.match(summary, /Session: \[session-1\]\(https:\/\/harness\.test\/sessions\/session-1\)/);
    assert.match(summary, /Created: yes/);
    assert.match(summary, /Concurrency: `concurrency-1`/);
    assert.match(summary, /Provider route: `prov-1` → `claude-print`/);
  });
});

test("labels the route as retained when no route is given", () => {
  withTempDir((dir) => {
    const summaryPath = join(dir, "summary");
    writeFileSync(summaryPath, "");
    writeOutputs({ GITHUB_STEP_SUMMARY: summaryPath }, result);
    assert.match(readFileSync(summaryPath, "utf8"), /retained from the existing session/);
  });
});

test("labels the route as retained when route is an empty array", () => {
  withTempDir((dir) => {
    const summaryPath = join(dir, "summary");
    writeFileSync(summaryPath, "");
    writeOutputs({ GITHUB_STEP_SUMMARY: summaryPath }, result, []);
    assert.match(readFileSync(summaryPath, "utf8"), /retained from the existing session/);
  });
});

test("omits the Concurrency row instead of rendering undefined when HARNESS_CONCURRENCY_ID is absent", () => {
  withTempDir((dir) => {
    const summaryPath = join(dir, "summary");
    writeFileSync(summaryPath, "");
    writeOutputs({ GITHUB_STEP_SUMMARY: summaryPath }, result);
    const summary = readFileSync(summaryPath, "utf8");
    assert.doesNotMatch(summary, /Concurrency/);
    assert.doesNotMatch(summary, /undefined/);
  });
});

test("writes a ::notice annotation to stdout when GITHUB_ACTIONS is true", () => {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    writeOutputs({ GITHUB_ACTIONS: "true" }, result);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(
    chunks.join(""),
    /^::notice title=Auto Harness session::session-1 created https:\/\/harness\.test\/sessions\/session-1$/m,
  );
});

test("does not write a ::notice annotation when GITHUB_ACTIONS is unset", () => {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    writeOutputs({}, result);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(chunks, []);
});
