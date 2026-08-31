import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeDrainOutputs } from "../src/actions/index.js";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "auto-harness-write-drain-outputs-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const drain = {
  operationId: "drain-1",
  repositoryId: "repo-1",
  status: "succeeded",
  statusUrl: "/api/v1/repositories/repo-1/session-drains/drain-1",
  requestedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
  deadlineAt: "2026-01-01T01:00:00.000Z",
  queuedCount: 2,
  runningCount: 1,
  cancelledCount: 3,
};

test("appends operation-id, status, and the three counts to GITHUB_OUTPUT when set", () => {
  withTempDir((dir) => {
    const outputPath = join(dir, "output");
    writeFileSync(outputPath, "");
    writeDrainOutputs({ GITHUB_OUTPUT: outputPath }, drain);
    assert.equal(
      readFileSync(outputPath, "utf8"),
      "operation-id=drain-1\nstatus=succeeded\nqueued-count=2\nrunning-count=1\ncancelled-count=3\nfailure-code=\n",
    );
  });
});

test("writes an empty failure-code when the drain has none", () => {
  withTempDir((dir) => {
    const outputPath = join(dir, "output");
    writeFileSync(outputPath, "");
    writeDrainOutputs({ GITHUB_OUTPUT: outputPath }, drain);
    assert.match(readFileSync(outputPath, "utf8"), /failure-code=\n$/);
  });
});

test("writes the failure-code when the drain reports one", () => {
  withTempDir((dir) => {
    const outputPath = join(dir, "output");
    writeFileSync(outputPath, "");
    writeDrainOutputs(
      { GITHUB_OUTPUT: outputPath },
      { ...drain, failureCode: "SESSION_CANCEL_FAILED" },
    );
    assert.match(readFileSync(outputPath, "utf8"), /failure-code=SESSION_CANCEL_FAILED\n$/);
  });
});

test("does nothing when GITHUB_OUTPUT is unset", () => {
  assert.doesNotThrow(() => writeDrainOutputs({}, drain));
});
