import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SESSION_OUTPUT_RETRY_WINDOW_MS } from "@auto-harness/shared";

import { SessionOutputSpool } from "./session-output-spool.ts";

const roots: string[] = [];
const DAY = 24 * 60 * 60 * 1000;

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-session-outputs-recovery-"));
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

async function storedErrors(
  root: string,
): Promise<Array<{ name: string; record: Record<string, unknown> }>> {
  const names = await readdir(join(root, "errors")).catch(() => [] as string[]);
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => ({
        name,
        record: JSON.parse(await readFile(join(root, "errors", name), "utf8")) as Record<
          string,
          unknown
        >,
      })),
  );
}

async function seedJobCapacity(root: string): Promise<void> {
  const jobs = join(root, "jobs");
  await mkdir(jobs, { recursive: true });
  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      mkdir(join(jobs, `seed-${String(index).padStart(3, "0")}.ready`)),
    ),
  );
}

async function seedErrorRecords(root: string, now: number, fresh: boolean): Promise<void> {
  const errors = join(root, "errors");
  await mkdir(errors, { recursive: true });
  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      writeFile(
        join(errors, `existing-${String(index).padStart(3, "0")}.json`),
        JSON.stringify({
          at: new Date(fresh || index >= 90 ? now - DAY : now - 8 * DAY).toISOString(),
        }),
      ),
    ),
  );
}

describe("SessionOutputSpool durable recovery edges", () => {
  it("turns an expired queued job into a retained error record", async () => {
    const root = await tempRoot();
    let now = 1_800_000_000_000;
    const spool = await captureEmptyJob(root, "expired-job", () => now);

    now += SESSION_OUTPUT_RETRY_WINDOW_MS + 1;
    await spool.runPass();

    expect(await readyJobDirs(root)).toEqual([]);
    expect(await storedErrors(root)).toEqual([
      expect.objectContaining({
        name: expect.stringMatching(/\.json$/),
        record: expect.objectContaining({
          sessionId: "expired-job",
          attemptId: "attempt-expired-job",
          code: "retry_window_expired",
        }),
      }),
    ]);
  });

  it("prunes expired error records before storing the next capacity error", async () => {
    const root = await tempRoot();
    const now = 1_800_000_000_000;
    await seedJobCapacity(root);
    await seedErrorRecords(root, now, false);
    const spool = new SessionOutputSpool({ root, now: () => now });
    const attempt = await spool.begin("capacity-prune", "attempt-capacity-prune");

    await attempt.capture();

    const errors = await storedErrors(root);
    expect(errors).toHaveLength(11);
    expect(
      errors
        .filter(({ name }) => name.startsWith("existing-"))
        .every(({ record }) => Date.parse(String(record.at)) > now - 7 * DAY),
    ).toBe(true);
    expect(
      errors.some(
        ({ record }) => record.sessionId === "capacity-prune" && record.code === "spool_capacity",
      ),
    ).toBe(true);
    expect(await readyJobDirs(root)).toHaveLength(100);
  });

  it("preserves valid output when the staged artifact tree disappears before archiving", async () => {
    const root = await tempRoot();
    const submissions: Array<{
      output: { state: string };
      artifacts: { state: string; error?: { code: string } };
    }> = [];
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn: async (input, init) => {
        if (String(input).endsWith("/outputs/prepare")) {
          submissions.push(JSON.parse(String(init?.body)) as (typeof submissions)[number]);
        }
        return Response.json({});
      },
    });
    const attempt = await spool.begin("missing-artifact-tree", "attempt-missing-tree");
    await writeFile(attempt.env.HARNESS_OUTPUT_FILE, '{"ok":true}', "utf8");
    await writeFile(join(attempt.env.HARNESS_ARTIFACTS_DIR, "keep.txt"), "captured", "utf8");
    await attempt.capture();
    const [ready] = await readyJobDirs(root);
    if (!ready) throw new Error("expected captured job");
    await rm(join(root, "jobs", ready, "artifacts"), { recursive: true });

    await spool.runPass();

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.output).toMatchObject({ state: "ready", jsonText: '{"ok":true}' });
    expect(submissions[0]?.artifacts).toMatchObject({
      state: "error",
      error: { code: "artifact_capture_failed" },
    });
    expect(await readyJobDirs(root)).toEqual([]);
  });

  it("does not archive content when the staged artifact root is replaced by a symlink", async () => {
    const root = await tempRoot();
    const submissions: Array<{ artifacts: { state: string; error?: { code: string } } }> = [];
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn: async (input, init) => {
        if (String(input).endsWith("/outputs/prepare")) {
          submissions.push(JSON.parse(String(init?.body)) as (typeof submissions)[number]);
        }
        return Response.json({});
      },
    });
    const attempt = await spool.begin("symlinked-artifact-root", "attempt-symlinked-root");
    await writeFile(join(attempt.env.HARNESS_ARTIFACTS_DIR, "inside.txt"), "captured", "utf8");
    await attempt.capture();
    const [ready] = await readyJobDirs(root);
    if (!ready) throw new Error("expected captured job");
    const artifactRoot = join(root, "jobs", ready, "artifacts");
    const external = join(root, "external-artifacts");
    await mkdir(external);
    await writeFile(join(external, "private.txt"), "outside the spool", "utf8");
    await rm(artifactRoot, { recursive: true });
    await symlink(external, artifactRoot, "dir");

    await spool.runPass();

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.artifacts).toMatchObject({
      state: "error",
      error: { code: "artifact_capture_failed" },
    });
    expect(await readyJobDirs(root)).toEqual([]);
  });
});
