import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SESSION_OUTPUT_RETRY_WINDOW_MS } from "@auto-harness/shared";
import { SessionOutputSpool } from "./session-output-spool.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("retains the job and API error code when completion needs a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-completion-retry-"));
  roots.push(root);
  let now = Date.now();
  let completions = 0;
  const messages: string[] = [];
  const spool = new SessionOutputSpool({
    root,
    now: () => now,
    identity: { apiUrl: "http://api.test" },
    onLog: (message) => messages.push(message),
    fetchFn: async (input) => {
      if (String(input).endsWith("/outputs/complete") && ++completions === 1)
        return Response.json({ error: { code: "BACKEND_BUSY" } }, { status: 503 });
      return Response.json({});
    },
  });
  const attempt = await spool.begin("session", "attempt");
  await attempt.capture();
  await spool.runPass();
  const jobs = await readdir(join(root, "jobs"));
  expect(jobs).toHaveLength(1);
  const persisted = JSON.parse(await readFile(join(root, "jobs", jobs[0]!, "job.json"), "utf8"));
  expect(persisted.retryAt).toBeGreaterThan(now);
  expect(
    messages.some((message) => message.includes("complete failed HTTP 503 BACKEND_BUSY")),
  ).toBe(true);
  now += 60_000;
  await spool.runPass();
  expect(completions).toBe(2);
  expect(await readdir(join(root, "jobs"))).toEqual([]);
});

it("preserves undated historical error metadata while recording an expired job", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-undated-error-"));
  roots.push(root);
  let now = Date.now();
  const spool = new SessionOutputSpool({
    root,
    now: () => now,
    identity: { apiUrl: "http://api.test" },
  });
  const attempt = await spool.begin("session", "attempt");
  await attempt.capture();
  await mkdir(join(root, "errors"));
  await writeFile(join(root, "errors", "historical.json"), "{}", "utf8");
  now += SESSION_OUTPUT_RETRY_WINDOW_MS + 1;
  await spool.runPass();
  expect(await readdir(join(root, "jobs"))).toEqual([]);
  const errors = await readdir(join(root, "errors"));
  expect(errors).toContain("historical.json");
  expect(errors).toHaveLength(2);
});
