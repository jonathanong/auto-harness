import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionOutputSpool } from "./session-output-spool.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionOutputSpool lifecycle", () => {
  it("recovers a stale intent once, logs malformed intents, and stops idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-output-lifecycle-"));
    temporary.push(root);
    const oldTime = Date.now() - 25 * 60 * 60 * 1000;
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
    const spool = new SessionOutputSpool({ root, onLog: (message) => messages.push(message) });
    spool.wake();
    spool.start();
    spool.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    spool.stop();
    spool.stop();
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
