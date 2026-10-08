import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionOutputSpool } from "./session-output-spool.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-session-output-error-retention-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seedCapacity(root: string, now: number): Promise<void> {
  await mkdir(join(root, "jobs"), { recursive: true });
  await mkdir(join(root, "errors"), { recursive: true });
  await Promise.all(
    Array.from({ length: 100 }, async (_, index) => {
      await mkdir(join(root, "jobs", `seed-${String(index).padStart(3, "0")}.ready`));
      await writeFile(
        join(root, "errors", `existing-${String(index).padStart(3, "0")}.json`),
        JSON.stringify({ at: new Date(now).toISOString() }),
      );
    }),
  );
  await writeFile(join(root, "errors", "corrupt-history.json"), "not-json", "utf8");
}

describe("SessionOutputSpool error overflow metadata", () => {
  it("rebuilds a corrupt overflow counter and continues incrementing it", async () => {
    const root = await tempRoot();
    const now = 1_800_000_000_000;
    await seedCapacity(root, now);
    await writeFile(join(root, "errors", "overflow.json"), "not-json", "utf8");
    const spool = new SessionOutputSpool({ root, now: () => now });
    for (const attemptId of ["attempt-overflow-a", "attempt-overflow-b"]) {
      const attempt = await spool.begin(`overflow-${attemptId}`, attemptId);
      await attempt.capture();
    }

    const overflow = JSON.parse(await readFile(join(root, "errors", "overflow.json"), "utf8")) as {
      count: number;
    };
    expect(overflow.count).toBe(2);
    expect(
      (await readdir(join(root, "errors"))).filter((name) => name.endsWith(".json")),
    ).toHaveLength(101);
  });

  it("treats an overflow counter without a count as zero", async () => {
    const root = await tempRoot();
    const now = 1_800_000_000_000;
    await seedCapacity(root, now);
    await writeFile(join(root, "errors", "overflow.json"), "{}", "utf8");
    const spool = new SessionOutputSpool({ root, now: () => now });
    const attempt = await spool.begin("overflow-default", "attempt-overflow-default");
    await attempt.capture();

    const overflow = JSON.parse(await readFile(join(root, "errors", "overflow.json"), "utf8")) as {
      count: number;
    };
    expect(overflow.count).toBe(1);
  });
});
