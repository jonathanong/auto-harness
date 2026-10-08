import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionOutputSpool } from "./session-output-spool.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("allows concurrent discard calls to release the same active attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-concurrent-discard-"));
  roots.push(root);
  const spool = new SessionOutputSpool({ root });
  const attempt = await spool.begin("session", "attempt");
  await Promise.all([attempt.discard(), attempt.discard()]);
  expect(await readdir(join(root, "attempts"))).toEqual([]);
  const replacement = await spool.begin("session", "attempt");
  await replacement.capture();
  expect(await readdir(join(root, "jobs"))).toHaveLength(1);
});

it("discards staging after an in-flight capture fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-failed-capture-discard-"));
  roots.push(root);
  const spool = new SessionOutputSpool({ root });
  const attempt = await spool.begin("session", "attempt");
  await writeFile(join(root, "jobs"), "blocked", "utf8");
  const failed = expect(attempt.capture()).rejects.toThrow();
  const discarded = attempt.discard();
  await failed;
  await discarded;
  expect(await readdir(join(root, "attempts"))).toEqual([]);
  expect(await attempt.discard()).toBeUndefined();
});
