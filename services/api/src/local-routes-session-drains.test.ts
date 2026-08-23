import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import type { SessionDrainRecord } from "./db/plane-storage.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

function drain(over: Partial<SessionDrainRecord> = {}): SessionDrainRecord {
  return {
    scopeKey: "repo#principal",
    recordKey: "OP#operation",
    operationId: "operation",
    repositoryId: "repo",
    principalId: "principal",
    status: "draining",
    requestedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: "2026-01-01T00:15:00.000Z",
    queuedCount: 1,
    runningCount: 2,
    cancelledCount: 3,
    ...over,
  };
}

async function harness() {
  const plane = new ControlPlane();
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
  return { plane, handler, invoke, author, other, host };
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
    const { plane, invoke, author } = await harness();
    const path = "/api/v1/repositories/repo/session-drains";
    let receivedKey: string | undefined;
    plane.createSessionDrainDurable = async (_repo, _principal, key) => {
      receivedKey = key;
      return { error: "repository not found", code: "NOT_FOUND" };
    };
    expect((await invoke("POST", path, author.apiKey, "deploy-1")).status).toBe(404);
    expect(receivedKey).toBe("deploy-1");
    plane.createSessionDrainDurable = async () => ({
      error: "invalid Idempotency-Key",
      code: "VALIDATION_ERROR",
    });
    expect((await invoke("POST", path, author.apiKey)).status).toBe(400);
    plane.createSessionDrainDurable = async () => ({
      error: "durable storage is required",
      code: "DURABLE_REQUIRED",
    });
    expect((await invoke("POST", path, author.apiKey)).status).toBe(409);
  });

  it("uses the first idempotency value when a proxy repeats the header", async () => {
    const { plane, handler, author } = await harness();
    let receivedKey: string | undefined;
    plane.createSessionDrainDurable = async (_repo, _principal, key) => {
      receivedKey = key;
      return { error: "durable storage is required", code: "DURABLE_REQUIRED" };
    };
    await expect(
      invokeHandler(handler, "POST", "/api/v1/repositories/repo/session-drains", {}, {
        authorization: `Bearer ${author.apiKey}`,
        "idempotency-key": ["first", "second"],
      } as never),
    ).resolves.toMatchObject({ status: 409 });
    expect(receivedKey).toBe("first");
  });

  it("maps missing, failed, and nonterminal operation outcomes", async () => {
    const { plane, invoke, author } = await harness();
    const operationPath = "/api/v1/repositories/repo/session-drains/operation";
    plane.getSessionDrainDurable = async () => null;
    expect((await invoke("GET", operationPath, author.apiKey)).status).toBe(404);
    plane.getSessionDrainDurable = async () =>
      drain({
        status: "failed",
        completedAt: "2026-01-01T00:15:00.000Z",
        failureCode: "DEADLINE_EXCEEDED",
      });
    expect((await invoke("GET", operationPath, author.apiKey)).json).toMatchObject({
      status: "failed",
      completedAt: "2026-01-01T00:15:00.000Z",
      failureCode: "DEADLINE_EXCEEDED",
    });
    plane.releaseSessionDrainDurable = async () => null;
    expect((await invoke("POST", `${operationPath}/release`, author.apiKey)).status).toBe(409);
  });

  it("returns success when release is retried after its response was lost", async () => {
    const { plane, invoke, author } = await harness();
    const operationPath = "/api/v1/repositories/repo/session-drains/operation";
    plane.getSessionDrainDurable = async () => drain({ status: "succeeded" });
    let releases = 0;
    plane.releaseSessionDrainDurable = async () => {
      releases += 1;
      return drain({ status: "released", releasedAt: "2026-01-01T00:01:00.000Z" });
    };

    await expect(invoke("POST", `${operationPath}/release`, author.apiKey)).resolves.toMatchObject({
      status: 200,
    });
    await expect(invoke("POST", `${operationPath}/release`, author.apiKey)).resolves.toMatchObject({
      status: 200,
    });
    expect(releases).toBe(2);
  });

  it("records unknown and failed terminal states when releasing a drain", async () => {
    const { plane, invoke, author } = await harness();
    const operationPath = "/api/v1/repositories/repo/session-drains/operation/release";
    const metadata: unknown[] = [];
    plane.appendAuditLog = async (record) => {
      metadata.push(record.metadata);
    };
    plane.getSessionDrainDurable = async () => null;
    plane.releaseSessionDrainDurable = async () => drain({ status: "released" });
    expect((await invoke("POST", operationPath, author.apiKey)).status).toBe(200);

    plane.getSessionDrainDurable = async () => drain({ status: "failed" });
    expect((await invoke("POST", operationPath, author.apiKey)).status).toBe(200);
    expect(metadata).toEqual([
      expect.objectContaining({ terminalStatus: "unknown", incomplete: false }),
      expect.objectContaining({ terminalStatus: "failed", incomplete: true }),
    ]);
  });

  it("fails closed when any durable operation throws", async () => {
    const { plane, invoke, author } = await harness();
    const collection = "/api/v1/repositories/repo/session-drains";
    const operation = `${collection}/operation`;
    plane.createSessionDrainDurable = async () => {
      throw new Error("create failed");
    };
    expect((await invoke("POST", collection, author.apiKey)).status).toBe(500);
    plane.getSessionDrainDurable = async () => {
      throw new Error("get failed");
    };
    expect((await invoke("GET", operation, author.apiKey)).status).toBe(500);
    expect((await invoke("POST", `${operation}/release`, author.apiKey)).status).toBe(500);
  });

  it("fails closed on drain audit writes and ignores unsupported operation methods", async () => {
    const { plane, invoke, author } = await harness();
    const collection = "/api/v1/repositories/repo/session-drains";
    const operation = `${collection}/operation`;
    plane.createSessionDrainDurable = async () => ({ created: true, drain: drain() });
    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect((await invoke("POST", collection, author.apiKey)).status).toBe(500);

    plane.getSessionDrainDurable = async () => drain({ status: "succeeded" });
    plane.releaseSessionDrainDurable = async () =>
      drain({ status: "released", releasedAt: "2026-01-01T00:01:00.000Z" });
    expect((await invoke("POST", `${operation}/release`, author.apiKey)).status).toBe(500);
    expect((await invoke("POST", operation, author.apiKey)).status).toBe(404);
  });
});
