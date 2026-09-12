/* eslint-disable max-lines -- durable admission, error mapping, pagination, and auth share fixtures. */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const mapping = vi.hoisted(() => ({ drain: null as string | null }));

vi.mock("./db/plane-storage-sessions.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db/plane-storage-sessions.ts")>();
  return {
    ...actual,
    sessionDrainOperationId: (_error: unknown) => mapping.drain ?? null,
  };
});

import { ControlPlane } from "./control-plane.ts";
import {
  createSessionChildDurable,
  listSessionChildrenDurable,
} from "./control-plane-session-children.ts";
import type { SessionRecord } from "./db/types.ts";
import {
  CatalogDeletionInProgressError,
  RepositoryAdmissionClosedError,
} from "./db/plane-storage-sessions-errors.ts";

function parent(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "parent",
    repositoryId: "repo",
    prompt: "parent prompt",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 90,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority: 3,
    requiredLabels: ["codex"],
    status: "running",
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    principalId: "parent-owner",
    ref: "feature/parent",
    rootSessionId: "root",
    ...over,
  };
}

function planeWithStorage(storage: Record<string, unknown>, source = parent()): ControlPlane {
  const plane = new ControlPlane({
    storage: storage as never,
    idFactory: () => "child",
    now: () => "2026-01-01T00:00:01.000Z",
    sessionCursorSecret: "test-secret",
  });
  plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo.git" });
  plane.createCommand({ id: "command", name: "command", argv: ["echo"], providerId: null });
  plane.state.sessions.set(source.id, source);
  return plane;
}

describe("durable child session branches", () => {
  it("creates and dedupes through storage while inheriting owner, ref, and root", async () => {
    const source = parent({ metadata: { ignored: "never inherited" } });
    const createSession = vi.fn(async (child: SessionRecord) => ({
      created: true as const,
      session: child,
    }));
    const plane = planeWithStorage({ getSession: async () => source, createSession }, source);
    const created = await createSessionChildDurable(
      plane.state,
      "parent",
      {
        prompt: "child prompt",
        spawnKey: "same-key",
        priority: 8,
        queueTtlSeconds: 30,
      },
      { sessionCredentialHash: "credential-hash" },
    );
    expect(created).toMatchObject({
      ok: true,
      created: true,
      session: {
        parentSessionId: "parent",
        rootSessionId: "root",
        metadata: { createdBy: "parent-owner" },
        ref: "feature/parent",
        priority: 8,
        queueTtlSeconds: 30,
      },
    });
    expect(createSession.mock.calls[0]![0]).toMatchObject({ principalId: "parent-owner" });
    expect(createSession.mock.calls[0]![2]).toEqual({
      id: "parent",
      sessionApiKeyHash: "credential-hash",
    });
    const duplicate = { ...(createSession.mock.calls[0]![0] as SessionRecord), id: "existing" };
    createSession.mockResolvedValueOnce({ created: false, session: duplicate });
    await expect(
      createSessionChildDurable(plane.state, "parent", {
        prompt: "child prompt",
        spawnKey: "same-key",
      }),
    ).resolves.toMatchObject({ ok: true, created: false, session: { id: "existing" } });
    expect(JSON.stringify(createSession.mock.calls[0]![0])).not.toContain("same-key");
  });

  it("uses explicit owner and root-parent fallbacks", async () => {
    const source = parent({
      rootSessionId: undefined,
      principalId: undefined,
      metadata: { createdBy: "legacy-owner" },
      ref: undefined,
    });
    const createSession = vi.fn(async (child: SessionRecord) => ({
      created: true as const,
      session: child,
    }));
    const plane = planeWithStorage({ getSession: async () => source, createSession }, source);
    await expect(
      createSessionChildDurable(
        plane.state,
        "parent",
        { prompt: "child", spawnKey: "key" },
        { principalId: "request-owner" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      session: { rootSessionId: "parent", metadata: { createdBy: "request-owner" } },
    });
    expect(createSession.mock.calls[0]![0]).toMatchObject({ principalId: "request-owner" });
    expect(createSession.mock.calls[0]![0]).not.toHaveProperty("ref");
  });

  it.each([
    ["draining", new Error("drain"), { code: "DRAINING", operationId: "drain-1" }],
    ["repository", new RepositoryAdmissionClosedError(), { code: "REPOSITORY_ADMISSION_CLOSED" }],
    ["conflict", new CatalogDeletionInProgressError(), { code: "CONFLICT" }],
  ])("maps %s storage errors", async (_name, error, expected) => {
    mapping.drain = _name === "draining" ? "drain-1" : null;
    const source = parent();
    const plane = planeWithStorage(
      { getSession: async () => source, createSession: async () => Promise.reject(error) },
      source,
    );
    await expect(
      createSessionChildDurable(plane.state, "parent", { prompt: "child", spawnKey: "key" }),
    ).resolves.toMatchObject({ ok: false, ...expected });
    mapping.drain = null;
  });

  it("propagates unexpected storage errors and rejects absent or noneligible parents", async () => {
    const source = parent();
    const unexpected = new Error("storage unavailable");
    const plane = planeWithStorage(
      { getSession: async () => source, createSession: async () => Promise.reject(unexpected) },
      source,
    );
    await expect(
      createSessionChildDurable(plane.state, "parent", { prompt: "child", spawnKey: "key" }),
    ).rejects.toBe(unexpected);
    const absent = planeWithStorage({ getSession: async () => null });
    await expect(createSessionChildDurable(absent.state, "missing", {})).resolves.toMatchObject({
      code: "NOT_FOUND",
    });
    const queued = parent({ status: "queued" });
    const blocked = planeWithStorage({ getSession: async () => queued }, queued);
    await expect(
      createSessionChildDurable(blocked.state, "parent", { prompt: "child", spawnKey: "key" }),
    ).resolves.toMatchObject({ code: "CONFLICT" });
  });

  it("returns inherited create validation failures", async () => {
    const source = parent();
    const plane = planeWithStorage({ getSession: async () => source }, source);
    plane.state.commands.delete("command");

    await expect(
      createSessionChildDurable(plane.state, "parent", { prompt: "child", spawnKey: "key" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("uses storage pagination with and without a next key", async () => {
    const first = parent({
      id: "child-a",
      parentSessionId: "parent",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const listSessionChildren = vi.fn(async () => ({ items: [first], nextKey: { id: "child-a" } }));
    const plane = planeWithStorage({ listSessionChildren });
    const page = await listSessionChildrenDurable(plane.state, "parent", {
      limit: 1,
      cursor: null,
    });
    expect(page).toMatchObject({ items: [first] });
    expect(page.nextCursor).toMatch(/^s1\./);
    listSessionChildren.mockResolvedValueOnce({ items: [first], nextKey: null });
    await expect(
      listSessionChildrenDurable(plane.state, "parent", { limit: 1, cursor: page.nextCursor }),
    ).resolves.toMatchObject({ items: [first], nextCursor: null });
    expect(listSessionChildren.mock.calls[1]![2]).toEqual({ id: "child-a" });
  });

  it("uses the session id to break equal creation-time ties in memory", async () => {
    const plane = new ControlPlane({ sessionCursorSecret: "test-secret" });
    const createdAt = "2026-01-02T00:00:00.000Z";
    plane.state.sessions.set(
      "child-a",
      parent({ id: "child-a", parentSessionId: "parent", createdAt }),
    );
    plane.state.sessions.set(
      "child-b",
      parent({ id: "child-b", parentSessionId: "parent", createdAt }),
    );

    await expect(
      listSessionChildrenDurable(plane.state, "parent", { limit: 2, cursor: null }),
    ).resolves.toMatchObject({ items: [{ id: "child-b" }, { id: "child-a" }] });
  });

  it("authenticates only a current durable session credential", async () => {
    const key = "hns_session_current";
    const source = parent({ sessionApiKeyHash: createHash("sha256").update(key).digest("hex") });
    const plane = planeWithStorage({ getSession: async () => source }, source);

    await expect(plane.authenticateSessionApiKey("parent", "ordinary-key")).resolves.toBe(false);
    await expect(plane.authenticateSessionApiKey("parent", key)).resolves.toBe(true);
    await expect(plane.authenticateSessionApiKey("parent", `${key}-wrong`)).resolves.toBe(false);
  });
});
