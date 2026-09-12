/* eslint-disable max-lines -- webhook and configuration route edge cases share fixtures. */
import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import { invokeBadJson, invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const secret = "g".repeat(32);

function encryptor(): SecretEncryptor {
  return {
    encrypt: async (value) => `cipher:${Buffer.from(value).toString("base64")}`,
    decrypt: async (value) => Buffer.from(value.slice("cipher:".length), "base64").toString("utf8"),
  };
}

async function fixture(configured = true) {
  const plane = new ControlPlane({
    secretEncryptor: encryptor(),
    idFactory: () => "session-github",
  });
  plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
  plane.createProvider({ id: "provider", name: "provider", defaultCommandId: "command" });
  plane.createCommand({ id: "command", name: "command", argv: ["echo"], providerId: "provider" });
  if (configured) await plane.createGitHubIngressConfig(configBody());
  return {
    plane,
    handler: createLocalApp({ plane, authMode: "disabled", rateLimitConfig: { enabled: false } })
      .handler,
  };
}

function configBody(overrides: Record<string, unknown> = {}) {
  return {
    secret,
    enabled: true,
    bindings: [
      {
        githubRepositoryId: 42,
        repositoryId: "repo",
        target: { providerId: "provider" },
        fallbacks: [],
        queueTtlSeconds: 3_600,
        timeout: 60,
        priority: 0,
        requiredLabels: [],
        defaultRef: "refs/heads/main",
        allowedLogins: [],
      },
    ],
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    action: "created",
    repository: { id: 42 },
    issue: { number: 5, pull_request: {} },
    comment: {
      id: 9,
      body: "@auto-harness fix this",
      author_association: "MEMBER",
      user: { login: "maintainer" },
    },
    ...overrides,
  };
}

function headers(value: unknown, delivery = "delivery-1") {
  const raw = JSON.stringify(value);
  return {
    "x-github-event": "issue_comment",
    "x-github-delivery": delivery,
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
  };
}

describe("GitHub App webhook ingress", () => {
  it("rejects unsupported methods, missing configuration, malformed bodies, and headers", async () => {
    const absent = await fixture(false);
    expect(await invokeHandler(absent.handler, "GET", "/api/v1/webhooks/github")).toMatchObject({
      status: 405,
      json: { error: { code: "METHOD_NOT_ALLOWED" } },
    });
    expect(
      await invokeHandler(absent.handler, "POST", "/api/v1/webhooks/github", body()),
    ).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    const configured = await fixture();
    expect(
      await invokeHandler(
        configured.handler,
        "POST",
        "/api/v1/webhooks/github",
        "x".repeat(1024 * 1024),
      ),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
    expect(await invokeBadJson(configured.handler, "POST", "/api/v1/webhooks/github")).toBe(401);
    const emptySignature = `sha256=${createHmac("sha256", secret).update("").digest("hex")}`;
    expect(
      await invokeHandler(configured.handler, "POST", "/api/v1/webhooks/github", undefined, {
        "x-hub-signature-256": emptySignature,
        "x-github-event": "issue_comment",
        "x-github-delivery": "empty",
      }),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
    const payload = body();
    const signed = headers(payload);
    delete signed["x-github-event"];
    expect(
      await invokeHandler(configured.handler, "POST", "/api/v1/webhooks/github", payload, signed),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
  });

  it("handles ignored events, disabled state, audit failure, create failure, and enqueue failure", async () => {
    const ignored = await fixture();
    const push = body({ action: "published" });
    expect(
      await invokeHandler(ignored.handler, "POST", "/api/v1/webhooks/github", push, {
        ...headers(push),
        "x-github-event": "push",
      }),
    ).toMatchObject({ status: 202, json: { accepted: false } });

    const disabled = await fixture();
    await disabled.plane.updateGitHubIngressConfig({
      enabled: false,
      bindings: [configBody().bindings[0]!],
    });
    const disabledPayload = body({ comment: { ...body().comment, id: 12 } });
    expect(
      await invokeHandler(
        disabled.handler,
        "POST",
        "/api/v1/webhooks/github",
        disabledPayload,
        headers(disabledPayload),
      ),
    ).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });

    const auditFailure = await fixture();
    auditFailure.plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      await invokeHandler(
        auditFailure.handler,
        "POST",
        "/api/v1/webhooks/github",
        push,
        headers(push),
      ),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });

    const createFailure = await fixture();
    vi.spyOn(createFailure.plane, "createGitHubIngressSessionDurable").mockResolvedValueOnce({
      ok: false,
      error: "stale integration",
      code: "CONFLICT",
    });
    expect(
      await invokeHandler(
        createFailure.handler,
        "POST",
        "/api/v1/webhooks/github",
        body(),
        headers(body()),
      ),
    ).toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });
    vi.restoreAllMocks();

    const failedCreateAudit = await fixture();
    vi.spyOn(failedCreateAudit.plane, "createGitHubIngressSessionDurable").mockResolvedValueOnce({
      ok: false,
      error: "stale integration",
      code: "CONFLICT",
    });
    failedCreateAudit.plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      await invokeHandler(
        failedCreateAudit.handler,
        "POST",
        "/api/v1/webhooks/github",
        body(),
        headers(body()),
      ),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
    vi.restoreAllMocks();

    const enqueueFailure = await fixture();
    const enqueueLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(enqueueFailure.plane, "enqueueAssignment").mockRejectedValueOnce(new Error("queue"));
    const enqueuePayload = body({ comment: { ...body().comment, id: 13 } });
    expect(
      await invokeHandler(
        enqueueFailure.handler,
        "POST",
        "/api/v1/webhooks/github",
        enqueuePayload,
        headers(enqueuePayload),
      ),
    ).toMatchObject({ status: 202, json: { accepted: true } });
    await vi.waitFor(() =>
      expect(enqueueLog).toHaveBeenCalledWith(
        "failed to enqueue GitHub ingress assignment",
        expect.any(Error),
      ),
    );
    vi.restoreAllMocks();

    const successAuditFailure = await fixture();
    const enqueue = vi.spyOn(successAuditFailure.plane, "enqueueAssignment");
    successAuditFailure.plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    const accepted = body({ comment: { ...body().comment, id: 14 } });
    expect(
      await invokeHandler(
        successAuditFailure.handler,
        "POST",
        "/api/v1/webhooks/github",
        accepted,
        headers(accepted),
      ),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
    expect(enqueue).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("verifies GitHub HMAC, persists the configured intent, and acknowledges without host assignment", async () => {
    const { plane, handler } = await fixture();
    const create = vi.spyOn(plane, "createGitHubIngressSessionDurable");
    const payload = body();
    const response = await invokeHandler(
      handler,
      "POST",
      "/api/v1/webhooks/github",
      payload,
      headers(payload),
    );
    expect(response).toMatchObject({
      status: 202,
      json: { accepted: true, sessionId: "session-github", created: true },
    });
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        integrationFence: expect.objectContaining({ generation: expect.any(String) }),
      }),
    );
    expect(plane.getSession("session-github")).toMatchObject({
      repositoryId: "repo",
      source: "webhook",
      ref: "refs/pull/5/head",
      concurrencyId: "github-comment:issue_comment:42:9",
      prompt: " fix this",
    });
    await expect(plane.listAuditLogs({ repositoryId: "repo" })).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          action: "webhook:github:receive",
          outcome: "success",
          repositoryId: "repo",
        }),
      ],
    });
  });

  it("reserves GitHub comment concurrency ids from the ordinary session API", async () => {
    const { handler } = await fixture();
    expect(
      await invokeHandler(handler, "POST", "/api/v1/sessions", {
        repositoryId: "repo",
        target: { providerId: "provider" },
        prompt: "bypass ingress",
        timeout: 60,
        concurrencyId: "github-comment:issue_comment:42:9",
      }),
    ).toMatchObject({
      status: 400,
      json: {
        error: {
          code: "VALIDATION_ERROR",
          message: "concurrencyId uses a reserved internal prefix",
        },
      },
    });
  });

  it("fails closed for invalid HMAC and acknowledges a verified unauthorized delivery without creating work", async () => {
    const { plane, handler } = await fixture();
    const payload = body();
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/webhooks/github", payload, {
          ...headers(payload),
          "x-hub-signature-256": "sha256=" + "0".repeat(64),
        })
      ).status,
    ).toBe(401);
    const denied = body({
      comment: {
        id: 10,
        body: "@auto-harness no",
        author_association: "NONE",
        user: { login: "stranger" },
      },
    });
    expect(
      await invokeHandler(
        handler,
        "POST",
        "/api/v1/webhooks/github",
        denied,
        headers(denied, "delivery-2"),
      ),
    ).toMatchObject({ status: 202, json: { accepted: false, reason: "unauthorized_author" } });
    expect(plane.listSessions()).toHaveLength(0);
    await expect(plane.listAuditLogs({ repositoryId: "repo" })).resolves.toMatchObject({
      items: [expect.objectContaining({ outcome: "denied", repositoryId: "repo" })],
    });
  });

  it("returns repository admission fences as conflicts while preserving their code", async () => {
    const { handler, plane } = await fixture();
    vi.spyOn(plane, "createGitHubIngressSessionDurable").mockResolvedValueOnce({
      ok: false,
      error: "repository admission is paused",
      code: "REPOSITORY_ADMISSION_CLOSED",
    });
    const payload = body({ comment: { ...body().comment, id: 11 } });
    expect(
      await invokeHandler(handler, "POST", "/api/v1/webhooks/github", payload, headers(payload)),
    ).toMatchObject({
      status: 409,
      json: { error: { code: "REPOSITORY_ADMISSION_CLOSED" } },
    });
    vi.restoreAllMocks();
  });

  it("uses the durable comment concurrency identity for duplicate GitHub delivery", async () => {
    const { plane, handler } = await fixture();
    const payload = body();
    const [first, second] = await Promise.all([
      invokeHandler(handler, "POST", "/api/v1/webhooks/github", payload, headers(payload, "a")),
      invokeHandler(handler, "POST", "/api/v1/webhooks/github", payload, headers(payload, "b")),
    ]);
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(plane.listSessions()).toHaveLength(1);
  });

  it("rejects malformed delivery ids before they enter audit or session metadata", async () => {
    const { handler } = await fixture();
    const payload = body();
    expect(
      await invokeHandler(handler, "POST", "/api/v1/webhooks/github", payload, {
        ...headers(payload),
        "x-github-delivery": "x".repeat(129),
      }),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
  });
});

describe("GitHub App ingress configuration routes", () => {
  it("covers missing rows, unsupported methods, parse errors, and fail-closed audits", async () => {
    const empty = await fixture(false);
    expect(
      await invokeHandler(empty.handler, "GET", "/api/v1/integrations/github-ingress"),
    ).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    expect(
      await invokeHandler(empty.handler, "PATCH", "/api/v1/integrations/github-ingress"),
    ).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    expect(await invokeBadJson(empty.handler, "POST", "/api/v1/integrations/github-ingress")).toBe(
      400,
    );
    for (const invalid of [
      null,
      { extra: true },
      { secret, bindings: "not-array" },
      { secret, bindings: [{ ...configBody().bindings[0], extra: true }] },
      { secret, bindings: [{ ...configBody().bindings[0], githubRepositoryId: "42" }] },
      { secret, bindings: [{ ...configBody().bindings[0], repositoryId: 42 }] },
      { secret, bindings: [null] },
      { secret, bindings: [{ ...configBody().bindings[0], target: null }] },
      { secret, bindings: [{ ...configBody().bindings[0], timeout: "60" }] },
      { secret, bindings: [{ ...configBody().bindings[0], fallbacks: "bad" }] },
      { secret, bindings: [{ ...configBody().bindings[0], fallbacks: [null] }] },
      { secret, bindings: [{ ...configBody().bindings[0], requiredLabels: "bad" }] },
      { secret, bindings: [{ ...configBody().bindings[0], requiredLabels: [42] }] },
      { secret, bindings: [{ ...configBody().bindings[0], allowedLogins: "bad" }] },
      { secret, bindings: [{ ...configBody().bindings[0], allowedLogins: [42] }] },
      { secret, bindings: [{ ...configBody().bindings[0], queueTtlSeconds: "bad" }] },
      { secret, bindings: [{ ...configBody().bindings[0], priority: "bad" }] },
      { secret, bindings: [{ ...configBody().bindings[0], defaultRef: 42 }] },
      { secret, bindings: [{ ...configBody().bindings[0], target: { providerId: 42 } }] },
      configBody({ version: 1 }),
    ]) {
      expect(
        await invokeHandler(empty.handler, "POST", "/api/v1/integrations/github-ingress", invalid),
      ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
    }
    expect(
      await invokeHandler(
        empty.handler,
        "PUT",
        "/api/v1/integrations/github-ingress",
        configBody(),
      ),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
    expect(
      await invokeHandler(
        empty.handler,
        "PUT",
        "/api/v1/integrations/github-ingress",
        configBody({ version: 1 }),
      ),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
    expect(
      await invokeHandler(
        empty.handler,
        "PUT",
        "/api/v1/integrations/github-ingress",
        configBody({ version: 1, generation: "legacy" }),
      ),
    ).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    expect(
      await invokeHandler(empty.handler, "DELETE", "/api/v1/integrations/github-ingress"),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
    expect(
      await invokeHandler(
        empty.handler,
        "DELETE",
        "/api/v1/integrations/github-ingress",
        undefined,
        { "if-match": "1", "if-match-generation": "legacy" },
      ),
    ).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    expect(
      await invokeHandler(empty.handler, "GET", "/api/v1/integrations/not-github"),
    ).toMatchObject({ status: 404 });
    expect(
      await invokeHandler(empty.handler, "PUT", "/api/v1/integrations/github-ingress", {
        ...configBody(),
        secret: 42,
      }),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });

    const getFailure = await fixture();
    vi.spyOn(getFailure.plane, "getGitHubIngressConfig").mockRejectedValueOnce(new Error("read"));
    expect(
      await invokeHandler(getFailure.handler, "GET", "/api/v1/integrations/github-ingress"),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
    vi.restoreAllMocks();

    const auditFailure = await fixture(false);
    auditFailure.plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      await invokeHandler(auditFailure.handler, "POST", "/api/v1/integrations/github-ingress", {
        bad: true,
      }),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
  });

  it("creates, reads, updates without rotating a blank secret, and deletes", async () => {
    const { plane, handler } = await fixture(false);
    const created = await invokeHandler(
      handler,
      "POST",
      "/api/v1/integrations/github-ingress",
      configBody(),
    );
    expect(created).toMatchObject({ status: 201, json: { secretConfigured: true, version: 1 } });
    expect(JSON.stringify(created.json)).not.toContain(secret);
    const generation = (created.json as { generation: string }).generation;
    expect(
      await invokeHandler(handler, "GET", "/api/v1/integrations/github-ingress"),
    ).toMatchObject({ status: 200, json: { enabled: true } });
    const update = configBody({
      enabled: false,
      version: 1,
      generation,
      bindings: [{ ...configBody().bindings[0], target: { commandId: "command" } }],
    });
    delete (update as { secret?: string }).secret;
    expect(
      await invokeHandler(handler, "PUT", "/api/v1/integrations/github-ingress", update),
    ).toMatchObject({ status: 200, json: { enabled: false, version: 2 } });
    expect(
      await invokeHandler(handler, "PUT", "/api/v1/integrations/github-ingress", update),
    ).toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });
    expect(
      await invokeHandler(handler, "DELETE", "/api/v1/integrations/github-ingress", undefined, {
        "if-match": "2",
        "if-match-generation": generation,
      }),
    ).toMatchObject({ status: 204 });
    await expect(plane.getGitHubIngressConfig()).resolves.toBeNull();
  });

  it("rejects stale mutation fences after delete and recreate", async () => {
    const { handler } = await fixture(false);
    const original = await invokeHandler(
      handler,
      "POST",
      "/api/v1/integrations/github-ingress",
      configBody(),
    );
    const oldGeneration = (original.json as { generation: string }).generation;
    expect(
      await invokeHandler(handler, "DELETE", "/api/v1/integrations/github-ingress", undefined, {
        "if-match": "1",
        "if-match-generation": oldGeneration,
      }),
    ).toMatchObject({ status: 204 });
    const recreated = await invokeHandler(
      handler,
      "POST",
      "/api/v1/integrations/github-ingress",
      configBody(),
    );
    expect((recreated.json as { generation: string }).generation).not.toBe(oldGeneration);
    const staleUpdate = configBody({ version: 1, generation: oldGeneration });
    delete (staleUpdate as { secret?: string }).secret;
    expect(
      await invokeHandler(handler, "PUT", "/api/v1/integrations/github-ingress", staleUpdate),
    ).toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });
    expect(
      await invokeHandler(handler, "DELETE", "/api/v1/integrations/github-ingress", undefined, {
        "if-match": "1",
        "if-match-generation": oldGeneration,
      }),
    ).toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });
  });

  it("rejects unknown nested target fields and invalid enabled types", async () => {
    const { handler } = await fixture(false);
    const nested = configBody();
    (nested.bindings[0]!.target as Record<string, unknown>).unexpected = true;
    expect(
      await invokeHandler(handler, "POST", "/api/v1/integrations/github-ingress", nested),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
    expect(
      await invokeHandler(
        handler,
        "POST",
        "/api/v1/integrations/github-ingress",
        configBody({ enabled: "yes" }),
      ),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
  });

  it("returns internal errors when configuration operations throw", async () => {
    const { plane, handler } = await fixture(false);
    vi.spyOn(plane, "createGitHubIngressConfig").mockRejectedValueOnce(new Error("kms"));
    expect(
      await invokeHandler(handler, "POST", "/api/v1/integrations/github-ingress", configBody()),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
    vi.restoreAllMocks();
    await plane.createGitHubIngressConfig(configBody());
    const current = await plane.getGitHubIngressConfig();
    vi.spyOn(plane, "deleteGitHubIngressConfig").mockRejectedValueOnce(new Error("storage"));
    expect(
      await invokeHandler(handler, "DELETE", "/api/v1/integrations/github-ingress", undefined, {
        "if-match": String(current!.version),
        "if-match-generation": current!.generation ?? "legacy",
      }),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
  });
});
