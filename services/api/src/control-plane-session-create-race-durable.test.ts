import { describe, expect, it } from "vitest";

import { createControlPlane } from "./create-plane.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("SessionCreateRace");

describe("durable session create races", () => {
  it("atomically admits only one of two concurrent durable creates", async () => {
    if (!ctx.available || !ctx.storage) return;
    await ctx.storage.putCommand({
      id: "cmd-concurrent-create",
      name: "concurrent create",
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
    const [first, second] = await Promise.all([
      createControlPlane({ ...base, idFactory: () => "concurrent-create-a" }),
      createControlPlane({ ...base, idFactory: () => "concurrent-create-b" }),
    ]);
    const body = {
      repositoryId: "repo-concurrent",
      prompt: "one durable session",
      commandId: "cmd-concurrent-create",
      timeout: 30,
      concurrencyId: "concurrent-create-key",
    };
    const outcomes = await Promise.all([
      first.plane.createSessionDurable(body),
      second.plane.createSessionDurable(body),
    ]);
    expect(outcomes.map((outcome) => outcome.ok && outcome.created).toSorted()).toEqual([
      false,
      true,
    ]);
    const created = outcomes.find((outcome) => outcome.ok && outcome.created);
    const duplicate = outcomes.find((outcome) => outcome.ok && !outcome.created);
    expect(created).toMatchObject({ ok: true });
    expect(duplicate).toMatchObject({ ok: true });
    if (!created?.ok || !duplicate?.ok) return;
    expect(duplicate.session.id).toBe(created.session.id);
    expect(
      (await ctx.storage.listAllSessions()).filter(
        (session) => session.concurrencyId === "concurrent-create-key",
      ),
    ).toHaveLength(1);
  });

  it("returns a bounded conflict for a generated ID reused by a terminal session", async () => {
    if (!ctx.available || !ctx.storage) return;
    await ctx.storage.putCommand({
      id: "cmd-fixed-id",
      name: "fixed id",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const { plane } = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => "terminal-id-collision",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    const body = {
      repositoryId: "repo-fixed-id",
      prompt: "fixed session id",
      commandId: "cmd-fixed-id",
      timeout: 30,
    };
    await expect(plane.createSessionDurable(body)).resolves.toMatchObject({
      ok: true,
      created: true,
    });
    plane.forceStatus("terminal-id-collision", "completed");
    await plane.settleStorage();
    await expect(plane.createSessionDurable(body)).resolves.toEqual({
      ok: false,
      error: "session creation conflicted; retry the request",
      code: "CONFLICT",
    });
  });
});
