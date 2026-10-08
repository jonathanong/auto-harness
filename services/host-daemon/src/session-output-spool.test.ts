import { createGunzip } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";

import { defaultSessionOutputsDir, SessionOutputSpool } from "./session-output-spool.ts";

const temporary: string[] = [];

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "harness-session-outputs-"));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function jobIn(root: string): Promise<Record<string, unknown>> {
  const jobs = await readdir(join(root, "jobs"));
  const ready = jobs.find((name) => name.endsWith(".ready"));
  if (!ready) throw new Error("expected a ready output job");
  return JSON.parse(await readFile(join(root, "jobs", ready, "job.json"), "utf8")) as Record<string, unknown>;
}

async function unpack(gzipBytes: Buffer): Promise<Array<{ name: string; body: string }>> {
  const found: Array<{ name: string; body: string }> = [];
  const tar = extract();
  tar.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      if (header.type === "file") found.push({ name: header.name, body: Buffer.concat(chunks).toString("utf8") });
      next();
    });
    stream.resume();
  });
  await pipeline(Readable.from([gzipBytes]), createGunzip(), tar);
  return found;
}

describe("SessionOutputSpool", () => {
  it("uses the private default directory and classifies invalid output files", async () => {
    expect(defaultSessionOutputsDir("/home/tester")).toBe(join("/home/tester", ".auto-harness", "session-outputs"));
    const root = await tempDirectory();
    const spool = new SessionOutputSpool({ root });
    const directory = await spool.begin("session-dir", "attempt-dir");
    await mkdir(directory.env.HARNESS_OUTPUT_FILE);
    const tooLarge = await spool.begin("session-large", "attempt-large");
    await writeFile(tooLarge.env.HARNESS_OUTPUT_FILE, Buffer.alloc(256 * 1024 + 1, 32));
    const invalidEncoding = await spool.begin("session-encoding", "attempt-encoding");
    await writeFile(invalidEncoding.env.HARNESS_OUTPUT_FILE, Buffer.from([0xff, 0xfe]));
    await Promise.all([directory.capture(), tooLarge.capture(), invalidEncoding.capture()]);
    const records = await Promise.all(
      ["attempt-dir", "attempt-large", "attempt-encoding"].map(async (attemptId) => {
        const jobs = await readdir(join(root, "jobs"));
        let ready: string | undefined;
        for (const name of jobs.filter((entry) => entry.endsWith(".ready"))) {
          const record = JSON.parse(await readFile(join(root, "jobs", name, "job.json"), "utf8")) as { attemptId: string };
          if (record.attemptId === attemptId) ready = name;
        }
        if (!ready) throw new Error(`missing job for ${attemptId}`);
        return JSON.parse(await readFile(join(root, "jobs", ready, "job.json"), "utf8")) as { attemptId: string; output: unknown };
      }),
    );
    expect(records.map(({ output }) => output)).toEqual([
      { state: "error", error: { code: "invalid_output_file", message: "Output path is not a regular file" } },
      { state: "error", error: { code: "output_too_large", message: "Output exceeds 262144 bytes" } },
      { state: "error", error: { code: "invalid_output_encoding", message: "Output must be valid UTF-8" } },
    ]);
  });

  it("stores valid JSON and a bounded tar.gz before publishing with the host identity", async () => {
    const root = await tempDirectory();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let uploaded = Buffer.alloc(0);
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "https://upload.test/object") {
        const chunks: Buffer[] = [];
        const body = init?.body;
        if (!body) throw new Error("missing upload body");
        for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        uploaded = Buffer.concat(chunks);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/outputs/prepare"))
        return Response.json({
          artifactUpload: {
            method: "PUT",
            url: "https://upload.test/object",
            headers: { "content-type": "application/gzip", "x-checksum-sha256": "server-token" },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
      if (url.endsWith("/outputs/complete")) return Response.json({ ok: true });
      throw new Error(`unexpected URL ${url}`);
    };
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test", apiKey: "host-secret" },
      fetchFn,
    });
    const attempt = await spool.begin("session-1", "attempt-1");
    expect(attempt.env.HARNESS_OUTPUT_FILE).toContain(join(root, "attempts"));
    expect(attempt.env.HARNESS_ARTIFACTS_DIR).not.toContain("checkout");
    await writeFile(attempt.env.HARNESS_OUTPUT_FILE, "null", "utf8");
    const nested = join(attempt.env.HARNESS_ARTIFACTS_DIR, "deep", "tree");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, `${"long-".repeat(22)}artifact.txt`), "artifact contents", "utf8");
    await attempt.capture();
    const job = await jobIn(root);
    expect(job.output).toMatchObject({ state: "ready", jsonText: "null" });
    expect(JSON.stringify(job)).not.toContain("host-secret");

    await spool.runPass();
    expect(requests.map(({ url }) => url)).toEqual([
      "http://api.test/api/v1/sessions/session-1/outputs/prepare",
      "https://upload.test/object",
      "http://api.test/api/v1/sessions/session-1/outputs/complete",
    ]);
    expect(((requests[0]?.init?.headers ?? {}) as Record<string, string>).authorization).toBe("Bearer host-secret");
    expect(((requests[1]?.init?.headers ?? {}) as Record<string, string>).authorization).toBe("Bearer host-secret");
    expect(uploaded.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    await expect(unpack(uploaded)).resolves.toEqual([
      { name: `deep/tree/${"long-".repeat(22)}artifact.txt`, body: "artifact contents" },
    ]);
    expect(await readdir(join(root, "jobs"))).toEqual([]);
  });

  it("publishes none for absent output and artifacts, and rejects empty or malformed JSON independently", async () => {
    const root = await tempDirectory();
    const submissions: unknown[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/outputs/prepare")) {
        submissions.push(JSON.parse(String(init?.body)));
        return Response.json({});
      }
      return Response.json({ ok: true });
    };
    const spool = new SessionOutputSpool({ root, identity: { apiUrl: "http://api.test" }, fetchFn });
    const missing = await spool.begin("session-none", "attempt-none");
    await missing.capture();
    const empty = await spool.begin("session-empty", "attempt-empty");
    await writeFile(empty.env.HARNESS_OUTPUT_FILE, "", "utf8");
    await empty.capture();
    const invalid = await spool.begin("session-invalid", "attempt-invalid");
    await writeFile(invalid.env.HARNESS_OUTPUT_FILE, "{broken", "utf8");
    await invalid.capture();
    await spool.runPass();
    expect(submissions).toHaveLength(3);
    const byAttempt = new Map(
      submissions.map((value) => {
        const submission = value as { attemptId: string; output: unknown; artifacts: unknown };
        return [submission.attemptId, submission] as const;
      }),
    );
    expect(byAttempt.get("attempt-none")).toMatchObject({ output: { state: "none" }, artifacts: { state: "none" } });
    expect(byAttempt.get("attempt-empty")?.output).toMatchObject({ state: "error", error: { code: "invalid_json" } });
    expect(byAttempt.get("attempt-invalid")?.output).toMatchObject({ state: "error", error: { code: "invalid_json" } });
  });

  it("records unsafe artifact trees as an artifact error without losing valid output JSON", async () => {
    const root = await tempDirectory();
    const submissions: unknown[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/outputs/prepare")) {
        submissions.push(JSON.parse(String(init?.body)));
        return Response.json({});
      }
      return Response.json({ ok: true });
    };
    const spool = new SessionOutputSpool({ root, identity: { apiUrl: "http://api.test" }, fetchFn });
    const attempt = await spool.begin("session-link", "attempt-link");
    await writeFile(attempt.env.HARNESS_OUTPUT_FILE, "{\"ok\":true}", "utf8");
    await symlink("/etc/passwd", join(attempt.env.HARNESS_ARTIFACTS_DIR, "escape"));
    await attempt.capture();
    await spool.runPass();
    const request = submissions[0] as { output: unknown; artifacts: { state: string; error?: { code: string } } };
    expect(request.output).toMatchObject({ state: "ready" });
    expect(request.artifacts).toMatchObject({ state: "error", error: { code: "artifact_capture_failed" } });
  });

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
    const first = new SessionOutputSpool({ root, identity: { apiUrl: "http://api.test" }, fetchFn, now: () => now });
    const attempt = await first.begin("session-restart", "attempt-restart");
    await writeFile(attempt.env.HARNESS_OUTPUT_FILE, "{\"persisted\":true}", "utf8");
    await attempt.capture();
    await first.runPass();
    expect(attempts).toBe(1);
    first.stop();

    now += 60_000;
    const restarted = new SessionOutputSpool({ root, identity: { apiUrl: "http://api.test" }, fetchFn, now: () => now });
    await restarted.runPass();
    expect(attempts).toBe(2);
    expect(requests.filter((url) => url.endsWith("/outputs/prepare"))).toHaveLength(2);
    expect(await readdir(join(root, "jobs"))).toEqual([]);
  });

  it("serializes admission at the job cap and records overflow without growing the queue", async () => {
    const root = await tempDirectory();
    const spool = new SessionOutputSpool({ root });
    const attempts = await Promise.all(
      Array.from({ length: 101 }, (_, index) => spool.begin(`session-${index}`, `attempt-${index}`)),
    );
    await Promise.all(attempts.map((attempt) => attempt.capture()));
    const jobs = await readdir(join(root, "jobs"));
    const errors = await readdir(join(root, "errors"));
    expect(jobs.filter((name) => name.endsWith(".ready"))).toHaveLength(100);
    expect(errors.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(await readdir(join(root, "attempts"))).toHaveLength(0);
  });
});
