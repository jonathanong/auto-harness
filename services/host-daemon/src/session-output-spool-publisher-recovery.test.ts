import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { SessionOutputSpool } from "./session-output-spool.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-session-outputs-publisher-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function captureEmptyJob(root: string, sessionId: string, now: () => number) {
  const spool = new SessionOutputSpool({ root, identity: { apiUrl: "http://api.test" }, now });
  const attempt = await spool.begin(sessionId, `attempt-${sessionId}`);
  await attempt.capture();
  return spool;
}

async function readyJobDirs(root: string): Promise<string[]> {
  const names = await readdir(join(root, "jobs"));
  return names.filter((name) => name.endsWith(".ready"));
}

describe("SessionOutputSpool publisher responses", () => {
  it.each([
    [404, undefined],
    [410, undefined],
    [409, "STALE_ATTEMPT"],
    [409, "RETENTION_STARTED"],
    [409, "OUTPUT_CONFLICT"],
  ] as const)("discards permanently rejected prepare (%s, %s)", async (status, code) => {
    const root = await tempRoot();
    const sessionId = `prepare-${status}-${code ?? "plain"}`;
    await captureEmptyJob(root, sessionId, () => Date.now());
    const logs: string[] = [];
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn: async () => Response.json(code ? { error: { code } } : {}, { status }),
      onLog: (message) => logs.push(message),
    });

    await spool.runPass();

    expect(await readyJobDirs(root)).toEqual([]);
    expect(logs).toContain(`session outputs discarded for ${sessionId}: ${code ?? status}`);
  });

  it("retries an unclassified conflict instead of treating every 409 as permanent", async () => {
    const root = await tempRoot();
    let now = Date.now();
    await captureEmptyJob(root, "prepare-conflict", () => now);
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      now: () => now,
      fetchFn: async () =>
        Response.json({ error: { code: "TEMPORARY_CONFLICT" } }, { status: 409 }),
    });

    await spool.runPass();

    const ready = await readyJobDirs(root);
    expect(ready).toHaveLength(1);
    const job = JSON.parse(await readFile(join(root, "jobs", ready[0]!, "job.json"), "utf8")) as {
      failures: number;
      retryAt: number;
    };
    expect(job.failures).toBe(1);
    expect(job.retryAt).toBeGreaterThan(now);
  });

  it.each([
    [404, undefined],
    [410, undefined],
    [409, "STALE_ATTEMPT"],
    [409, "RETENTION_STARTED"],
    [409, "OUTPUT_CONFLICT"],
  ] as const)("discards permanently rejected completion (%s, %s)", async (status, code) => {
    const root = await tempRoot();
    const sessionId = `complete-${status}-${code ?? "plain"}`;
    await captureEmptyJob(root, sessionId, () => Date.now());
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn: async (input) =>
        String(input).endsWith("/outputs/prepare")
          ? Response.json({})
          : Response.json(code ? { error: { code } } : {}, { status }),
    });

    await spool.runPass();

    expect(await readyJobDirs(root)).toEqual([]);
  });

  it("sends the archived bytes as a bounded multipart upload before completion", async () => {
    const root = await tempRoot();
    const now = Date.now();
    const logs: string[] = [];
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      now: () => now,
      onLog: (message) => logs.push(message),
      fetchFn: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/outputs/prepare")) {
          return Response.json({
            artifactUpload: {
              method: "POST",
              url: "https://upload.test/post",
              fields: { key: "signed-object-key" },
              expiresAt: new Date(now + 60_000).toISOString(),
            },
          });
        }
        if (url === "https://upload.test/post") {
          const chunks: Buffer[] = [];
          if (!init?.body) throw new Error("multipart body is missing");
          if (!init.headers || typeof init.headers !== "object")
            throw new Error("multipart headers are missing");
          const headers = init.headers as Record<string, string>;
          for await (const chunk of init.body as AsyncIterable<Uint8Array>)
            chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString("utf8");
          const multipartBody = Buffer.concat(chunks);
          const contentType = headers["content-type"];
          if (!contentType) throw new Error("multipart content type is missing");
          const boundary = contentType.split("boundary=")[1]!;
          expect(init.method).toBe("POST");
          expect(contentType).toMatch(/^multipart\/form-data; boundary=harness-/);
          expect(body).toContain('name="key"');
          expect(body).toContain("signed-object-key");
          expect(body).toContain('filename="artifacts.tar.gz"');
          const archiveStart = multipartBody.indexOf(Buffer.from([0x1f, 0x8b]));
          const archiveEnd = multipartBody.lastIndexOf(Buffer.from(`\r\n--${boundary}--\r\n`));
          expect(
            gunzipSync(multipartBody.subarray(archiveStart, archiveEnd)).toString("utf8"),
          ).toContain("artifact bytes");
          return new Response(null, { status: 204 });
        }
        return Response.json({});
      },
    });
    const attempt = await spool.begin("multipart-upload", "attempt-multipart");
    const artifactDir = attempt.env.HARNESS_ARTIFACTS_DIR;
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "output.txt"), "artifact bytes", "utf8");
    await attempt.capture();

    await spool.runPass();

    expect(logs).toEqual([]);
    expect(await readyJobDirs(root)).toEqual([]);
  });

  it("retries a transient completion failure and discards a later permanent rejection", async () => {
    const root = await tempRoot();
    let now = Date.now();
    await captureEmptyJob(root, "complete-retry", () => now);
    let completeCalls = 0;
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      now: () => now,
      fetchFn: async (input) => {
        if (String(input).endsWith("/outputs/prepare")) return Response.json({});
        completeCalls += 1;
        return completeCalls === 1
          ? Response.json({}, { status: 503 })
          : Response.json({}, { status: 410 });
      },
    });

    await spool.runPass();
    const ready = await readyJobDirs(root);
    expect(ready).toHaveLength(1);
    const failed = JSON.parse(
      await readFile(join(root, "jobs", ready[0]!, "job.json"), "utf8"),
    ) as {
      failures: number;
      retryAt: number;
    };
    expect(failed.failures).toBe(1);
    expect(failed.retryAt).toBeGreaterThan(now);

    now = failed.retryAt + 1;
    await spool.runPass();

    expect(completeCalls).toBe(2);
    expect(await readyJobDirs(root)).toEqual([]);
  });
});
