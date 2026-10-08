import { randomBytes } from "node:crypto";
import { mkdtemp, open, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_SESSION_ARTIFACT_BYTES, MAX_SESSION_ARTIFACT_FILES } from "@auto-harness/shared";

import { SessionOutputSpool } from "./session-output-spool.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionOutputSpool archive bounds", () => {
  it("stops compression at the compressed archive limit and reports an independent artifact error", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-compressed-cap-"));
    temporary.push(root);
    let artifactState: unknown;
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/outputs/prepare")) {
        artifactState = (JSON.parse(String(init?.body)) as { artifacts: unknown }).artifacts;
      }
      return Response.json({ ok: true });
    };
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn,
    });
    const attempt = await spool.begin("session-compressed-limit", "attempt-compressed-limit");
    const file = await open(join(attempt.env.HARNESS_ARTIFACTS_DIR, "random.bin"), "w");
    const chunkSize = 1024 * 1024;
    const count = Math.ceil((MAX_SESSION_ARTIFACT_BYTES + 2 * chunkSize) / chunkSize);
    for (let index = 0; index < count; index += 1) {
      await file.writeFile(randomBytes(chunkSize));
    }
    await file.close();
    await attempt.capture();
    await spool.runPass();
    expect(artifactState).toMatchObject({
      state: "error",
      error: { code: "artifact_capture_failed" },
    });
  });

  it("rejects more than the bounded traversal entry count", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-tree-cap-"));
    temporary.push(root);
    let artifactState: unknown;
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/outputs/prepare")) {
        artifactState = (JSON.parse(String(init?.body)) as { artifacts: unknown }).artifacts;
      }
      return Response.json({ ok: true });
    };
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn,
    });
    const attempt = await spool.begin("session-tree-limit", "attempt-tree-limit");
    for (let index = 0; index <= MAX_SESSION_ARTIFACT_FILES * 2; index += 1) {
      await mkdir(join(attempt.env.HARNESS_ARTIFACTS_DIR, `directory-${index}`));
    }
    await attempt.capture();
    await spool.runPass();
    expect(artifactState).toMatchObject({
      state: "error",
      error: { code: "artifact_capture_failed" },
    });
  });
});
