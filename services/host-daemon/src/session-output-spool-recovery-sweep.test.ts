import { chmod, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionOutputSpool } from "./session-output-spool.ts";

const temporary: string[] = [];

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "harness-session-output-recovery-"));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionOutputSpool abandoned attempt recovery", () => {
  it("keeps a young orphan during startup grace and removes it after the age window", async () => {
    const root = await tempDirectory();
    let now = Date.now();
    const original = new SessionOutputSpool({ root, now: () => now });
    const attempt = await original.begin("session-aged-orphan", "attempt-aged-orphan");
    const attemptDirectory = join(root, "attempts", attempt.jobId);
    original.stop();

    now += 24 * 60 * 60 * 1_000;
    const restarted = new SessionOutputSpool({ root, now: () => now });
    await restarted.runPass();
    expect(
      await stat(attemptDirectory).then(
        () => true,
        () => false,
      ),
    ).toBe(true);

    now += 60_001;
    await restarted.runPass();
    expect(
      await stat(attemptDirectory).then(
        () => true,
        () => false,
      ),
    ).toBe(true);

    now += 8 * 24 * 60 * 60 * 1_000;
    await restarted.runPass();
    expect(
      await stat(attemptDirectory).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("preserves an old attempt while its handle is live in this daemon", async () => {
    const root = await tempDirectory();
    let now = Date.now();
    const spool = new SessionOutputSpool({ root, now: () => now });
    const attempt = await spool.begin("session-live-attempt", "attempt-live-attempt");
    const attemptDirectory = join(root, "attempts", attempt.jobId);
    now += 9 * 24 * 60 * 60 * 1_000;
    await spool.runPass();
    now += 60_001;
    await spool.runPass();
    expect(
      await stat(attemptDirectory).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    await writeFile(attempt.env.HARNESS_OUTPUT_FILE, "null", "utf8");
    await attempt.capture();
    expect(await readdir(join(root, "jobs"))).toHaveLength(1);
  });

  it("removes a crash-created attempt directory whose intent was never written", async () => {
    const root = await tempDirectory();
    let now = Date.now();
    const name = "a".repeat(64);
    const directory = join(root, "attempts", name);
    await mkdir(join(directory, "artifacts"), { recursive: true });
    const abandonedAt = new Date(now - 9 * 24 * 60 * 60 * 1_000);
    await utimes(directory, abandonedAt, abandonedAt);
    const spool = new SessionOutputSpool({ root, now: () => now });
    await spool.runPass();
    now += 60_001;
    await spool.runPass();
    expect(
      await stat(directory).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("releases a failed discard handle so the aged attempt can be swept", async () => {
    const root = await tempDirectory();
    let now = Date.now();
    const spool = new SessionOutputSpool({ root, now: () => now });
    const attempt = await spool.begin("session-discard-failure", "attempt-discard-failure");
    const attemptsDirectory = join(root, "attempts");
    const attemptDirectory = join(attemptsDirectory, attempt.jobId);
    await chmod(attemptsDirectory, 0);
    await expect(attempt.discard()).rejects.toThrow();
    await chmod(attemptsDirectory, 0o700);

    now += 10 * 24 * 60 * 60 * 1_000;
    await spool.runPass();
    now += 60_001;
    await spool.runPass();
    expect(
      await stat(attemptDirectory).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("reaches attempts beyond multiple bounded sweep pages", async () => {
    const root = await tempDirectory();
    let now = Date.now();
    const original = new SessionOutputSpool({ root, now: () => now });
    const attempts = await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        original.begin(`session-page-${index}`, `attempt-page-${index}`),
      ),
    );
    const directory = join(root, "attempts");
    const names = await readdir(directory);
    const laterName = names.at(-1)!;
    original.stop();

    now += 9 * 24 * 60 * 60 * 1_000;
    const restarted = new SessionOutputSpool({ root, now: () => now });
    await restarted.runPass();
    expect(
      await stat(join(directory, laterName)).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    now += 60 * 60_000;
    await restarted.runPass();
    expect(
      await stat(join(directory, laterName)).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    now += 60 * 60_000;
    await restarted.runPass();
    expect(
      await stat(join(directory, laterName)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(attempts).toHaveLength(205);
  });
});
