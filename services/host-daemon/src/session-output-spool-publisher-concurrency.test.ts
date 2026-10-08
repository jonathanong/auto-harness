import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionOutputSpool } from "./session-output-spool.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-session-outputs-publisher-concurrency-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readyJobDirs(root: string): Promise<string[]> {
  return (await readdir(join(root, "jobs"))).filter((name) => name.endsWith(".ready"));
}

describe("SessionOutputSpool publisher concurrency and malformed errors", () => {
  it("shares the active publisher pass with concurrent callers", async () => {
    const root = await tempRoot();
    let markPrepareStarted!: () => void;
    let releasePrepare!: () => void;
    const prepareStarted = new Promise<void>((resolve) => {
      markPrepareStarted = resolve;
    });
    const prepareCanFinish = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    let prepareCalls = 0;
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn: async (input) => {
        if (String(input).endsWith("/outputs/prepare")) {
          prepareCalls += 1;
          markPrepareStarted();
          await prepareCanFinish;
        }
        return Response.json({});
      },
    });
    const attempt = await spool.begin("parallel-publisher", "attempt-parallel-publisher");
    await attempt.capture();

    const first = spool.runPass();
    await prepareStarted;
    const concurrent = spool.runPass();
    releasePrepare();
    await Promise.all([first, concurrent]);

    expect(prepareCalls).toBe(1);
    expect(await readyJobDirs(root)).toEqual([]);
  });

  it("retries API errors with absent or non-string error codes", async () => {
    const root = await tempRoot();
    const logs: string[] = [];
    let prepareCalls = 0;
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      onLog: (message) => logs.push(message),
      fetchFn: async (input) => {
        if (!String(input).endsWith("/outputs/prepare")) return Response.json({});
        prepareCalls += 1;
        return prepareCalls === 1
          ? new Response("not-json", { status: 503 })
          : Response.json({ error: { code: 7 } }, { status: 503 });
      },
    });
    for (const sessionId of ["bad-error-code-a", "bad-error-code-b"]) {
      const attempt = await spool.begin(sessionId, `attempt-${sessionId}`);
      await attempt.capture();
    }

    await spool.runPass();

    expect(logs.filter((message) => message.includes("prepare failed HTTP 503"))).toHaveLength(2);
    expect(await readyJobDirs(root)).toHaveLength(2);
  });
});
