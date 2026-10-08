import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_SESSION_ARTIFACT_SOURCE_BYTES } from "@auto-harness/shared";

import { SessionOutputSpool } from "./session-output-spool.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionOutputSpool staging capacity", () => {
  it("admits the full per-session source limit with archive staging headroom", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-capacity-"));
    temporary.push(root);
    const submissions: Array<{ artifacts: { state: string; sourceBytes?: number } }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/outputs/prepare")) {
        submissions.push(JSON.parse(String(init?.body)) as (typeof submissions)[number]);
      }
      return Response.json({ ok: true });
    };
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn,
    });
    const attempt = await spool.begin("session-max-source", "attempt-max-source");
    const file = await open(join(attempt.env.HARNESS_ARTIFACTS_DIR, "sparse.bin"), "w");
    await file.truncate(MAX_SESSION_ARTIFACT_SOURCE_BYTES);
    await file.close();
    await attempt.capture();
    await spool.runPass();
    expect(submissions[0]?.artifacts).toMatchObject({
      state: "pending",
      sourceBytes: MAX_SESSION_ARTIFACT_SOURCE_BYTES,
      fileCount: 1,
    });
  });

  it("reports artifact source bytes beyond the per-session limit independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-source-limit-"));
    temporary.push(root);
    let submission: { artifacts: { state: string; error?: { code: string } } } | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/outputs/prepare"))
        submission = JSON.parse(String(init?.body)) as typeof submission;
      return Response.json({ ok: true });
    };
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn,
    });
    const attempt = await spool.begin("session-over-source", "attempt-over-source");
    const file = await open(join(attempt.env.HARNESS_ARTIFACTS_DIR, "too-large.bin"), "w");
    await file.truncate(MAX_SESSION_ARTIFACT_SOURCE_BYTES + 1);
    await file.close();
    await attempt.capture();
    await spool.runPass();
    expect(submission?.artifacts).toMatchObject({
      state: "error",
      error: { code: "artifact_capture_failed" },
    });
  });

  it("rejects an archive reservation that would exceed total staging capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-reserve-capacity-"));
    temporary.push(root);
    const otherSpoolFile = await open(join(root, "other-spool-data.bin"), "w");
    await otherSpoolFile.truncate(950 * 1024 * 1024);
    await otherSpoolFile.close();
    let submission: { artifacts: { state: string; error?: { code: string } } } | undefined;
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn: async (input, init) => {
        if (String(input).endsWith("/outputs/prepare"))
          submission = JSON.parse(String(init?.body)) as typeof submission;
        return Response.json({});
      },
    });
    const attempt = await spool.begin("session-reserve-limit", "attempt-reserve-limit");
    const artifact = await open(join(attempt.env.HARNESS_ARTIFACTS_DIR, "sparse.bin"), "w");
    await artifact.truncate(MAX_SESSION_ARTIFACT_SOURCE_BYTES);
    await artifact.close();
    await attempt.capture();

    await spool.runPass();

    expect(submission?.artifacts).toMatchObject({
      state: "error",
      error: { code: "artifact_capture_failed" },
    });
  });
});
