import { describe, expect, it } from "vitest";

import { createControlPlane } from "./create-plane.ts";
import { createDynamoTestCtx, putActiveTestRepository } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("SessionCloneRace");

describe("durable session clone races", () => {
  it("creates two independent clones across API workers", async () => {
    if (!ctx.available || !ctx.storage) return;
    await putActiveTestRepository(ctx.storage, "repo-clone-race");
    await ctx.storage.putCommand({
      id: "cmd-clone-race",
      name: "clone race",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const base = {
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    };
    const sourceWorker = await createControlPlane({ ...base, idFactory: () => "clone-source" });
    await expect(
      sourceWorker.plane.createSessionDurable({
        repositoryId: "repo-clone-race",
        prompt: "rerun me",
        target: { commandId: "cmd-clone-race" },
        timeout: 30,
        concurrencyId: "source-concurrency",
      }),
    ).resolves.toMatchObject({ ok: true, created: true });
    sourceWorker.plane.forceStatus("clone-source", "completed");
    await sourceWorker.plane.settleStorage();

    const [first, second] = await Promise.all([
      createControlPlane({ ...base, idFactory: () => "clone-a" }),
      createControlPlane({ ...base, idFactory: () => "clone-b" }),
    ]);
    const outcomes = await Promise.all([
      first.plane.cloneSessionDurable("clone-source"),
      second.plane.cloneSessionDurable("clone-source"),
    ]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          created: true,
          session: expect.objectContaining({ id: "clone-a" }),
        }),
        expect.objectContaining({
          ok: true,
          created: true,
          session: expect.objectContaining({ id: "clone-b" }),
        }),
      ]),
    );
    const sessions = (await ctx.storage.listAllSessions()).filter((session) =>
      ["clone-a", "clone-b"].includes(session.id),
    );
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.concurrencyId === undefined)).toBe(true);
    expect(sessions.every((session) => session.status === "queued")).toBe(true);
  });
});
