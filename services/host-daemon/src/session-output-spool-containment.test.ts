import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionOutputSpool } from "./session-output-spool.ts";

const temporary: string[] = [];

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "harness-session-output-containment-"));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionOutputSpool containment", () => {
  it("contains spool scan failures and reports them instead of rejecting a daemon pass", async () => {
    const root = await tempDirectory();
    await writeFile(join(root, "jobs"), "not a directory", "utf8");
    const messages: string[] = [];
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      onLog: (message) => messages.push(message),
    });
    await expect(spool.runPass()).resolves.toBeUndefined();
    expect(messages.some((message) => message.includes("session output spool pass failed"))).toBe(
      true,
    );
  });

  it("bounds each publisher pass and reports an oversized recovered queue", async () => {
    const root = await tempDirectory();
    const jobs = join(root, "jobs");
    await mkdir(jobs);
    for (let index = 0; index < 102; index += 1)
      await mkdir(join(jobs, `${String(index).padStart(3, "0")}.ready`));
    const messages: string[] = [];
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      onLog: (message) => messages.push(message),
      fetchFn: async () => Response.json({ ok: true }),
    });
    await spool.runPass();
    expect(messages.some((message) => message.includes("more than 100 job entries"))).toBe(true);
    expect(messages.filter((message) => message.includes("metadata unreadable"))).toHaveLength(25);
  });

  it("logs malformed deferred-attempt metadata without selecting another attempt", async () => {
    const root = await tempDirectory();
    const messages: string[] = [];
    const spool = new SessionOutputSpool({ root, onLog: (message) => messages.push(message) });
    const attempt = await spool.begin("session-malformed-deferred", "attempt-malformed-deferred");
    const intentPath = join(dirname(attempt.env.HARNESS_OUTPUT_FILE), "intent.json");
    await writeFile(intentPath, "not-json", "utf8");
    await expect(
      spool.findDeferredAttempt("session-malformed-deferred", "attempt-malformed-deferred"),
    ).resolves.toBeUndefined();
    expect(
      messages.some((message) => message.includes("deferred session output recovery failed")),
    ).toBe(true);
  });
});
