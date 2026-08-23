/* eslint-disable max-lines -- session-drain route outcomes share one authenticated harness. */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import {
  SessionDrainLedgerUnavailableError,
  type SessionDrainRecord,
} from "./db/plane-storage-session-drains.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

function drain(principalId: string, over: Partial<SessionDrainRecord> = {}): SessionDrainRecord {
  return {
    scopeKey: "repo#principal",
    recordKey: "operation",
    operationId: "operation",
    repositoryId: "repo",
    principalId,
    status: "draining",
    requestedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: "2026-01-01T00:15:00.000Z",
    queuedCount: 0,
    runningCount: 0,
    cancelledCount: 0,
    ...over,
  };
}

function sessionDrainStorage(plane: ControlPlane) {
  const drains = new Map<string, SessionDrainRecord>();
  const released = new Map<string, SessionDrainRecord>();
  const createCalls: Array<{ record: SessionDrainRecord; actor: unknown }> = [];
  const releaseCalls: Array<{ record: SessionDrainRecord; actor: unknown }> = [];
  const standaloneAudits: unknown[] = [];
  let createFailure: Error | undefined;
  let getFailure: Error | undefined;
  let releaseFailure: Error | undefined;
  const storage = {
    createOrGetSessionDrain: async (record: SessionDrainRecord, actor: unknown) => {
      createCalls.push({ record, actor });
      if (createFailure) throw createFailure;
      const existing = drains.get(record.operationId);
      if (existing) return { created: false, drain: { ...existing } };
      drains.set(record.operationId, { ...record });
      return { created: true, drain: { ...record } };
    },
    getSessionDrain: async (repositoryId: string, principalId: string) =>
      [...released.values(), ...drains.values()].find(
        (record) => record.repositoryId === repositoryId && record.principalId === principalId,
      ) ?? null,
    getSessionDrainOperation: async (
      repositoryId: string,
      principalId: string,
      operationId: string,
    ) => {
      if (getFailure) throw getFailure;
      const record = drains.get(operationId);
      return record?.repositoryId === repositoryId && record.principalId === principalId
        ? { ...record }
        : null;
    },
    listSessionsForDrain: async () => [],
    putAuditLog: async (record: unknown) => {
      standaloneAudits.push(record);
    },
    releaseSessionDrain: async (record: SessionDrainRecord, actor: unknown) => {
      releaseCalls.push({ record, actor });
      if (releaseFailure) throw releaseFailure;
      released.set(record.operationId, { ...record });
      return { ...record };
    },
    updateSessionDrain: async (record: SessionDrainRecord) => {
      drains.set(record.operationId, { ...record });
      return true;
    },
  };
  setDurableReadStorage(plane.state, storage);
  return {
    createCalls,
    drains,
    releaseCalls,
    standaloneAudits,
    failCreate(error: Error): void {
      createFailure = error;
    },
    failGet(error: Error): void {
      getFailure = error;
    },
    failRelease(error: Error): void {
      releaseFailure = error;
    },
    clearFailures(): void {
      createFailure = undefined;
      getFailure = undefined;
      releaseFailure = undefined;
    },
  };
}

async function harness(options: { durable?: boolean } = {}) {
  const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
  const storage = options.durable === false ? undefined : sessionDrainStorage(plane);
  plane.state.repositories.set("repo", {
    id: "repo",
    name: "repo",
    url: "url",
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const auth = new AuthService({
    mode: "required",
    secret: "r".repeat(32),
    admins: admins(),
  });
  const author = await auth.createServiceAccount({
    name: "author",
    role: "author",
    allowedRepositoryIds: ["repo"],
  });
  const other = await auth.createServiceAccount({
    name: "other",
    role: "author",
    allowedRepositoryIds: ["other"],
  });
  const host = await auth.createServiceAccount({
    name: "host",
    role: "agent",
    allowedRepositoryIds: ["repo"],
    boundHostId: "host",
  });
  const { handler } = createLocalApp({
    plane,
    authService: auth,
    rateLimitConfig: { enabled: false },
  });
  const invoke = (method: string, path: string, apiKey?: string, idempotencyKey?: string) =>
    invokeHandler(
      handler,
      method,
      path,
      {},
      {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
    );
  return { plane, handler, invoke, author, other, host, storage };
}

describe("session drain route outcomes", () => {
  it("hides unauthorized scopes and rejects missing authentication", async () => {
    const { invoke, author, other, host } = await harness();
    const path = "/api/v1/repositories/repo/session-drains";
    expect((await invoke("POST", path)).status).toBe(401);
    expect((await invoke("POST", path, other.apiKey)).status).toBe(404);
    expect((await invoke("POST", path, host.apiKey)).status).toBe(404);
    expect((await invoke("PUT", path, author.apiKey)).status).toBe(404);
  });

  it("maps create failures and forwards one idempotency header", async () => {
    const { plane, invoke, author, storage } = await harness();
    const path = "/api/v1/repositories/repo/session-drains";
    expect(storage).toBeDefined();
    plane.state.repositories.delete("repo");
    expect((await invoke("POST", path, author.apiKey, "deploy-1")).status).toBe(404);
    plane.state.repositories.set("repo", {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await invoke("POST", path, author.apiKey, "bad key")).status).toBe(400);
    storage!.failCreate(new SessionDrainLedgerUnavailableError());
    expect((await invoke("POST", path, author.apiKey, "ledger")).status).toBe(409);
    expect(storage!.createCalls).toEqual([
      expect.objectContaining({
        record: expect.objectContaining({
          operationId: `drain-${createHash("sha256")
            .update(`repo\0${author.account.id}\0ledger`)
            .digest("hex")
            .slice(0, 32)}`,
        }),
        actor: expect.objectContaining({
          actor: expect.objectContaining({ id: author.account.id, kind: "service-account" }),
        }),
      }),
    ]);
    const withoutStorage = await harness({ durable: false });
    expect((await withoutStorage.invoke("POST", path, withoutStorage.author.apiKey)).status).toBe(
      409,
    );
  });

  it("uses the first idempotency value when a proxy repeats the header", async () => {
    const { handler, author, storage } = await harness();
    await expect(
      invokeHandler(handler, "POST", "/api/v1/repositories/repo/session-drains", {}, {
        authorization: `Bearer ${author.apiKey}`,
        "idempotency-key": ["first", "second"],
      } as never),
    ).resolves.toMatchObject({ status: 202 });
    expect(storage!.createCalls).toEqual([
      expect.objectContaining({
        record: expect.objectContaining({ operationId: expect.any(String) }),
      }),
    ]);
    expect(storage!.createCalls[0]!.record.operationId).toBe(
      `drain-${createHash("sha256")
        .update(`repo\0${author.account.id}\0first`)
        .digest("hex")
        .slice(0, 32)}`,
    );
  });

  it("maps missing, failed, and nonterminal operation outcomes", async () => {
    const { invoke, author, storage } = await harness();
    const operationPath = "/api/v1/repositories/repo/session-drains/operation";
    expect((await invoke("GET", operationPath, author.apiKey)).status).toBe(404);
    storage!.drains.set(
      "operation",
      drain(author.account.id, {
        status: "failed",
        completedAt: "2026-01-01T00:15:00.000Z",
        failureCode: "DEADLINE_EXCEEDED",
        queuedCount: 1,
        runningCount: 2,
        cancelledCount: 3,
      }),
    );
    expect((await invoke("GET", operationPath, author.apiKey)).json).toMatchObject({
      status: "failed",
      completedAt: "2026-01-01T00:15:00.000Z",
      failureCode: "DEADLINE_EXCEEDED",
    });
    storage!.drains.set("operation", {
      ...storage!.drains.get("operation")!,
      status: "draining",
    });
    expect((await invoke("POST", `${operationPath}/release`, author.apiKey)).status).toBe(409);
  });

  it("returns success when release is retried after its response was lost", async () => {
    const { invoke, author, storage } = await harness();
    const operationPath = "/api/v1/repositories/repo/session-drains/operation";
    storage!.drains.set(
      "operation",
      drain(author.account.id, {
        status: "succeeded",
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await expect(invoke("POST", `${operationPath}/release`, author.apiKey)).resolves.toMatchObject({
      status: 200,
    });
    await expect(invoke("POST", `${operationPath}/release`, author.apiKey)).resolves.toMatchObject({
      status: 200,
    });
    expect(storage!.releaseCalls).toHaveLength(1);
  });

  it("passes the authenticated actor into the atomic release audit", async () => {
    const { invoke, author, storage } = await harness();
    const operationPath = "/api/v1/repositories/repo/session-drains/operation/release";
    storage!.drains.set(
      "operation",
      drain(author.account.id, {
        status: "succeeded",
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect((await invoke("POST", operationPath, author.apiKey)).status).toBe(200);
    expect(storage!.releaseCalls).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({
          actor: expect.objectContaining({ id: author.account.id, kind: "service-account" }),
        }),
      }),
    ]);
  });

  it("fails closed when any durable operation throws", async () => {
    const { invoke, author, storage } = await harness();
    const collection = "/api/v1/repositories/repo/session-drains";
    const operation = `${collection}/operation`;
    storage!.failCreate(new Error("create failed"));
    expect((await invoke("POST", collection, author.apiKey)).status).toBe(500);
    storage!.clearFailures();
    storage!.failGet(new Error("get failed"));
    expect((await invoke("GET", operation, author.apiKey)).status).toBe(500);
    storage!.clearFailures();
    storage!.failRelease(new Error("release failed"));
    storage!.drains.set(
      "operation",
      drain(author.account.id, {
        status: "succeeded",
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect((await invoke("POST", `${operation}/release`, author.apiKey)).status).toBe(500);
  });

  it("does not hide an atomic drain operation behind a second route audit write", async () => {
    const { invoke, author, storage } = await harness();
    const collection = "/api/v1/repositories/repo/session-drains";
    expect((await invoke("POST", collection, author.apiKey)).status).toBe(202);

    const created = [...storage!.drains.values()][0]!;
    const operation = `${collection}/${created.operationId}`;
    storage!.drains.set(created.operationId, { ...created, status: "succeeded" });
    expect((await invoke("POST", `${operation}/release`, author.apiKey)).status).toBe(200);
    expect((await invoke("POST", operation, author.apiKey)).status).toBe(404);
    expect(storage!.standaloneAudits).toEqual([]);
  });
});
