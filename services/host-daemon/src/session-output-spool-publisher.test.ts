import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionOutputSpool } from "./session-output-spool.ts";

const temporary: string[] = [];

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "harness-session-output-publisher-"));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionOutputSpool publisher", () => {
  it("recovers a durable job after restart and retries a transient API failure", async () => {
    const root = await tempDirectory();
    let now = Date.now();
    let attempts = 0;
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      requests.push(String(input));
      if (String(input).endsWith("/outputs/prepare")) {
        attempts += 1;
        return attempts === 1 ? Response.json({}, { status: 503 }) : Response.json({});
      }
      return Response.json({ ok: true });
    };
    const first = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn,
      now: () => now,
    });
    const attempt = await first.begin("session-restart", "attempt-restart");
    await writeFile(attempt.env.HARNESS_OUTPUT_FILE, '{"persisted":true}', "utf8");
    await attempt.capture();
    await first.runPass();
    expect(attempts).toBe(1);
    first.stop();

    now += 60_000;
    const restarted = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn,
      now: () => now,
    });
    await restarted.runPass();
    expect(attempts).toBe(2);
    expect(requests.filter((url) => url.endsWith("/outputs/prepare"))).toHaveLength(2);
    expect(await readdir(join(root, "jobs"))).toEqual([]);
  });

  it("retries unsettled outputs, uploads AWS multipart fields, then completes", async () => {
    const root = await tempDirectory();
    let now = Date.now();
    let prepareCount = 0;
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, init });
      if (url.endsWith("/outputs/prepare")) {
        prepareCount += 1;
        if (prepareCount === 1)
          return Response.json({ error: { code: "OUTPUTS_NOT_SETTLED" } }, { status: 409 });
        return Response.json({
          artifactUpload: {
            method: "POST",
            url: "https://bucket.test/upload",
            fields: { key: "session-aws", policy: "policy" },
            expiresAt: new Date(now + 60_000).toISOString(),
          },
        });
      }
      if (url === "https://bucket.test/upload") {
        const body = init?.body;
        if (!body) throw new Error("missing multipart upload body");
        let text = "";
        for await (const chunk of body as AsyncIterable<Uint8Array>)
          text += Buffer.from(chunk).toString("utf8");
        expect(text).toContain('name="key"');
        expect(text).toContain("session-aws");
        expect(text).toContain("artifacts.tar.gz");
      }
      return Response.json({ ok: true });
    };
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "https://api.test", apiKey: "host-secret" },
      fetchFn,
      now: () => now,
    });
    const attempt = await spool.begin("session-aws", "attempt-aws");
    await mkdir(join(attempt.env.HARNESS_ARTIFACTS_DIR, "folder"));
    await writeFile(join(attempt.env.HARNESS_ARTIFACTS_DIR, "folder", "a.txt"), "file", "utf8");
    await attempt.capture();
    await spool.runPass();
    expect(prepareCount).toBe(1);
    now += 60_000;
    await spool.runPass();
    expect(seen.map(({ url }) => url)).toEqual([
      "https://api.test/api/v1/sessions/session-aws/outputs/prepare",
      "https://api.test/api/v1/sessions/session-aws/outputs/prepare",
      "https://bucket.test/upload",
      "https://api.test/api/v1/sessions/session-aws/outputs/complete",
    ]);
    expect(await readdir(join(root, "jobs"))).toEqual([]);
  });

  it("discards retention-started records and records jobs that expire before a retry", async () => {
    const root = await tempDirectory();
    let now = Date.now();
    const codes: Array<string | undefined> = ["RETENTION_STARTED"];
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).endsWith("/outputs/prepare")) {
        const code = codes.shift();
        return code
          ? Response.json({ error: { code } }, { status: 410 })
          : Response.json({}, { status: 503 });
      }
      return Response.json({ ok: true });
    };
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn,
      now: () => now,
    });
    const retained = await spool.begin("session-retention", "attempt-retention");
    await retained.capture();
    const expiring = await spool.begin("session-expired", "attempt-expired");
    await expiring.capture();
    await spool.runPass();
    expect(
      (await readdir(join(root, "jobs"))).filter((name) => name.endsWith(".ready")),
    ).toHaveLength(1);
    now += 25 * 60 * 60 * 1000;
    await spool.runPass();
    expect(await readdir(join(root, "jobs"))).toEqual([]);
    expect(await readdir(join(root, "errors"))).toHaveLength(1);
  });

  it("restores only the matching deferred attempt and discards an uncaptured attempt", async () => {
    const root = await tempDirectory();
    const spool = new SessionOutputSpool({ root });
    const attempt = await spool.begin("session-deferred", "attempt-deferred");
    await expect(
      spool.findDeferredAttempt("session-other", "attempt-deferred"),
    ).resolves.toBeUndefined();
    const restored = await spool.findDeferredAttempt("session-deferred", "attempt-deferred");
    expect(restored?.env).toEqual(attempt.env);
    await expect(attempt.discard()).resolves.toBeUndefined();
    await expect(
      spool.findDeferredAttempt("session-deferred", "attempt-deferred"),
    ).resolves.toBeUndefined();
  });
});
