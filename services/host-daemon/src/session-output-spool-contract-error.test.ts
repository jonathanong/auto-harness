import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionOutputSpool } from "./session-output-spool.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionOutputSpool contract mismatch recovery", () => {
  it("keeps a durable job when the server requests an artifact that was not captured", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-contract-error-"));
    temporary.push(root);
    const messages: string[] = [];
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      onLog: (message) => messages.push(message),
      fetchFn: async () =>
        Response.json({
          artifactUpload: {
            method: "PUT",
            url: "https://bucket.test/missing",
            headers: {},
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
    });
    const attempt = await spool.begin("session-unexpected-upload", "attempt-unexpected-upload");
    await attempt.capture();
    await spool.runPass();
    expect(messages.some((message) => message.includes("without a local archive"))).toBe(true);
    expect((await readdir(join(root, "jobs"))).some((name) => name.endsWith(".ready"))).toBe(true);
  });
});
