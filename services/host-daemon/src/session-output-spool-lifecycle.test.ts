import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultSessionOutputsDir, SessionOutputSpool } from "./session-output-spool.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionOutputSpool lifecycle", () => {
  it("uses the per-user spool root by default without touching it", async () => {
    const spool = new SessionOutputSpool({});
    expect(defaultSessionOutputsDir("/tmp/harness-home")).toBe(
      join("/tmp/harness-home", ".auto-harness", "session-outputs"),
    );
    spool.stop();
  });

  it("reuses an uncaptured attempt directory and makes capture/discard idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-reuse-"));
    temporary.push(root);
    const spool = new SessionOutputSpool({ root });
    const first = await spool.begin("session-reuse", "attempt-reuse");
    await writeFile(first.env.HARNESS_OUTPUT_FILE, "ignored", "utf8");
    const resumed = await spool.begin("session-reuse", "attempt-reuse");
    await writeFile(resumed.env.HARNESS_OUTPUT_FILE, "null", "utf8");
    await resumed.capture();
    await resumed.capture();
    await first.discard();
    await resumed.discard();
    expect(await readdir(join(root, "jobs"))).toHaveLength(1);
  });

  it("rejects mismatched intents and already-captured attempt directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-intent-"));
    temporary.push(root);
    const spool = new SessionOutputSpool({ root });
    const mismatch = await spool.begin("session-intent", "attempt-intent");
    const mismatchDirectory = dirname(mismatch.env.HARNESS_OUTPUT_FILE);
    await writeFile(
      join(mismatchDirectory, "intent.json"),
      JSON.stringify({ sessionId: "other-session", attemptId: "attempt-intent" }),
    );
    await expect(spool.begin("session-intent", "attempt-intent")).rejects.toThrow(
      "session output attempt directory has a mismatched intent",
    );
    await expect(
      spool.findDeferredAttempt("session-intent", "attempt-intent"),
    ).resolves.toBeUndefined();

    const captured = await spool.begin("session-captured", "attempt-captured");
    await writeFile(join(dirname(captured.env.HARNESS_OUTPUT_FILE), "job.json"), "{}");
    await expect(spool.begin("session-captured", "attempt-captured")).rejects.toThrow(
      "session output attempt was already captured",
    );
  });

  it("retries capture after a staging failure and shares concurrent capture work", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-capture-retry-"));
    temporary.push(root);
    const spool = new SessionOutputSpool({ root });
    const attempt = await spool.begin("session-retry-capture", "attempt-retry-capture");
    await writeFile(attempt.env.HARNESS_OUTPUT_FILE, "null", "utf8");
    await writeFile(join(root, "jobs"), "not a directory", "utf8");
    await expect(attempt.capture()).rejects.toThrow();
    await rm(join(root, "jobs"));
    await mkdir(join(root, "jobs"));
    await Promise.all([attempt.capture(), attempt.capture()]);
    await attempt.capture();
    expect(await readdir(join(root, "jobs"))).toHaveLength(1);
  });

  it("waits for an in-flight capture before discarding an attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-capture-discard-"));
    temporary.push(root);
    const spool = new SessionOutputSpool({ root });
    const attempt = await spool.begin("session-capture-discard", "attempt-capture-discard");
    await writeFile(attempt.env.HARNESS_OUTPUT_FILE, "null", "utf8");

    const capture = attempt.capture();
    const discard = attempt.discard();
    await Promise.all([capture, discard]);

    expect(await readdir(join(root, "jobs"))).toHaveLength(1);
  });

  it("returns cleanly for an empty or unavailable publisher spool", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-empty-"));
    temporary.push(root);
    const disconnected = new SessionOutputSpool({ root });
    await disconnected.runPass();
    const messages: string[] = [];
    const connected = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      onLog: (message) => messages.push(message),
    });
    await connected.runPass();
    expect(messages).toEqual([]);
  });

  it("recovers a stale intent once, logs malformed intents, and stops idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-lifecycle-"));
    temporary.push(root);
    const oldTime = Date.now() - 9 * 24 * 60 * 60 * 1_000;
    const initial = new SessionOutputSpool({ root, now: () => oldTime });
    const stale = await initial.begin("session-stale", "attempt-stale");
    const intent = join(dirname(stale.env.HARNESS_OUTPUT_FILE), "intent.json");
    await writeFile(
      intent,
      JSON.stringify({
        sessionId: "session-stale",
        attemptId: "attempt-stale",
        begunAt: new Date(oldTime).toISOString(),
      }),
    );
    const malformed = await initial.begin("session-malformed", "attempt-malformed");
    await writeFile(join(dirname(malformed.env.HARNESS_OUTPUT_FILE), "intent.json"), "not-json");

    const messages: string[] = [];
    let now = Date.now();
    const spool = new SessionOutputSpool({
      root,
      now: () => now,
      onLog: (message) => messages.push(message),
    });
    spool.wake();
    spool.start();
    spool.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    spool.stop();
    spool.stop();
    now += 60_001;
    await spool.runPass();

    const records = await readdir(join(root, "errors"));
    expect(records).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, "errors", records[0]!), "utf8"))).toMatchObject({
      sessionId: "session-stale",
      code: "daemon_interrupted",
    });
    expect(
      messages.some((message) => message.includes("session output intent recovery failed")),
    ).toBe(true);
  });
});
