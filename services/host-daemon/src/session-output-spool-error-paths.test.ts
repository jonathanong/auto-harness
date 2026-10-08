import { chmod, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionOutputSpool } from "./session-output-spool.ts";

const temporary: string[] = [];

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "harness-session-output-errors-"));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionOutputSpool error paths", () => {
  it("rejects a replaced output symlink and preserves the artifact-independent error", async () => {
    const root = await tempDirectory();
    const outside = join(root, "outside.json");
    await writeFile(outside, '{"private":true}', "utf8");
    const submissions: unknown[] = [];
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn: async (_input, init) => {
        submissions.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      },
    });
    const attempt = await spool.begin("session-output-link", "attempt-output-link");
    await writeFile(attempt.env.HARNESS_OUTPUT_FILE, "{}", "utf8");
    await rm(attempt.env.HARNESS_OUTPUT_FILE);
    await symlink(outside, attempt.env.HARNESS_OUTPUT_FILE);
    await attempt.capture();
    await spool.runPass();
    expect(submissions[0]).toMatchObject({
      output: { state: "error", error: { code: "invalid_output_file" } },
      artifacts: { state: "none" },
    });
    expect(JSON.stringify(submissions[0])).not.toContain("private");
  });

  it("records a readable filesystem error when the output file cannot be opened", async () => {
    const root = await tempDirectory();
    const submissions: unknown[] = [];
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn: async (_input, init) => {
        submissions.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      },
    });
    const attempt = await spool.begin("session-unreadable-output", "attempt-unreadable-output");
    await writeFile(attempt.env.HARNESS_OUTPUT_FILE, "{}", "utf8");
    await chmod(attempt.env.HARNESS_OUTPUT_FILE, 0);
    await attempt.capture();
    const ready = (await readdir(join(root, "jobs"))).find((name) => name.endsWith(".ready"));
    if (!ready) throw new Error("expected output job");
    await chmod(join(root, "jobs", ready, "output.json"), 0o600);
    await spool.runPass();
    expect(submissions[0]).toMatchObject({
      output: { state: "error", error: { code: "output_read_failed" } },
    });
  });

  it("refreshes an expired artifact URL on retry and then completes publication", async () => {
    const root = await tempDirectory();
    let now = Date.now();
    let prepares = 0;
    const uploaded: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/outputs/prepare")) {
        prepares += 1;
        return Response.json({
          artifactUpload: {
            method: "PUT",
            url: `https://bucket.test/${prepares}`,
            headers: { "content-type": "application/gzip" },
            expiresAt: new Date(now + (prepares === 1 ? -1 : 60_000)).toISOString(),
          },
        });
      }
      if (url.startsWith("https://bucket.test/")) {
        uploaded.push(url);
        return new Response(null, { status: 204 });
      }
      return Response.json({ ok: true });
    };
    const messages: string[] = [];
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn,
      now: () => now,
      onLog: (message) => messages.push(message),
    });
    const attempt = await spool.begin("session-expired-url", "attempt-expired-url");
    await writeFile(join(attempt.env.HARNESS_ARTIFACTS_DIR, "artifact.txt"), "payload", "utf8");
    await attempt.capture();
    await spool.runPass();
    expect(uploaded).toEqual([]);
    expect(messages.some((message) => message.includes("artifact upload URL expired"))).toBe(true);
    now += 10 * 60_000;
    await spool.runPass();
    expect(uploaded).toEqual(["https://bucket.test/2"]);
    expect(await readdir(join(root, "jobs"))).toEqual([]);
  });

  it("retries an artifact upload failure without losing its durable job", async () => {
    const root = await tempDirectory();
    let now = Date.now();
    let uploadCount = 0;
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      now: () => now,
      fetchFn: async (input) => {
        const url = String(input);
        if (url.endsWith("/outputs/prepare"))
          return Response.json({
            artifactUpload: {
              method: "PUT",
              url: "https://bucket.test/object",
              headers: { "content-type": "application/gzip" },
              expiresAt: new Date(now + 60_000).toISOString(),
            },
          });
        if (url === "https://bucket.test/object") {
          uploadCount += 1;
          return new Response(null, { status: uploadCount === 1 ? 503 : 204 });
        }
        return Response.json({ ok: true });
      },
    });
    const attempt = await spool.begin("session-upload-retry", "attempt-upload-retry");
    await writeFile(join(attempt.env.HARNESS_ARTIFACTS_DIR, "artifact.txt"), "payload", "utf8");
    await attempt.capture();
    await spool.runPass();
    expect((await readdir(join(root, "jobs"))).some((name) => name.endsWith(".ready"))).toBe(true);
    now += 10 * 60_000;
    await spool.runPass();
    expect(uploadCount).toBe(2);
    expect(await readdir(join(root, "jobs"))).toEqual([]);
  });

  it("rebuilds an uncommitted archive left by an interrupted publication pass", async () => {
    const root = await tempDirectory();
    let submission: unknown;
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn: async (input, init) => {
        if (String(input).endsWith("/outputs/prepare")) submission = JSON.parse(String(init?.body));
        return Response.json({ ok: true });
      },
    });
    const attempt = await spool.begin("session-stale-archive", "attempt-stale-archive");
    await writeFile(join(attempt.env.HARNESS_ARTIFACTS_DIR, "artifact.txt"), "source", "utf8");
    await attempt.capture();
    const ready = (await readdir(join(root, "jobs"))).find((name) => name.endsWith(".ready"));
    if (!ready) throw new Error("expected a ready output job");
    await writeFile(join(root, "jobs", ready, "artifacts.tar.gz"), "partial archive", "utf8");
    await spool.runPass();
    expect(submission).toMatchObject({ artifacts: { state: "pending", fileCount: 1 } });
  });

  it("completes a none submission when prepare returns a non-JSON success body", async () => {
    const root = await tempDirectory();
    const calls: string[] = [];
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn: async (input) => {
        const url = String(input);
        calls.push(url);
        return url.endsWith("/outputs/prepare")
          ? new Response("not-json", { status: 200 })
          : Response.json({ ok: true });
      },
    });
    const attempt = await spool.begin("session-invalid-prepare", "attempt-invalid-prepare");
    await attempt.capture();
    await spool.runPass();
    expect(calls).toEqual([
      "http://api.test/api/v1/sessions/session-invalid-prepare/outputs/prepare",
      "http://api.test/api/v1/sessions/session-invalid-prepare/outputs/complete",
    ]);
    expect(await readdir(join(root, "jobs"))).toEqual([]);
  });
});
