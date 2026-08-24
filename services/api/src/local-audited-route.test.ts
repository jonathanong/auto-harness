import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  commitMutationAudit,
  denyRepositoryScope,
  readJsonBody,
  readJsonBodyWithAudit,
  repositoryInScope,
  sendHiddenNotFound,
  sendRouteError,
} from "./local-audited-route.ts";
import type { RouteCtx } from "./local-http.ts";

function fakeRes(): {
  res: RouteCtx["res"];
  status: () => number;
  json: () => unknown;
} {
  const chunks: Buffer[] = [];
  let status = 0;
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end(payload?: string) {
      if (payload) chunks.push(Buffer.from(payload));
    },
  };
  return {
    res: res as unknown as RouteCtx["res"],
    status: () => status,
    json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
  };
}

function fakeReq(body: string | Record<string, unknown>): RouteCtx["req"] {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === "data") cb(Buffer.from(payload));
      if (event === "end") cb();
      return this;
    },
  } as unknown as RouteCtx["req"];
}

function ctx(partial: Partial<RouteCtx> & Pick<RouteCtx, "res">): RouteCtx {
  return {
    plane: new ControlPlane(),
    req: fakeReq({}),
    url: new URL("http://127.0.0.1/api/v1/x"),
    method: "POST",
    ...partial,
  };
}

describe("audited route helpers", () => {
  it("parses JSON and reports invalid bodies with a consistent envelope", async () => {
    const okRes = fakeRes();
    const parsed = await readJsonBody(ctx({ req: fakeReq({ name: "ok" }), res: okRes.res }));
    expect(parsed).toEqual({ ok: true, body: { name: "ok" } });

    const badRes = fakeRes();
    const failed = await readJsonBody(ctx({ req: fakeReq("{bad"), res: badRes.res }));
    expect(failed).toEqual({ ok: false });
    expect(badRes.status()).toBe(400);
    expect(badRes.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
    });
  });

  it("audits invalid JSON and fail-closes when audit storage rejects", async () => {
    const audited = fakeRes();
    const plane = new ControlPlane();
    const failed = await readJsonBodyWithAudit(
      ctx({ plane, req: fakeReq("{bad"), res: audited.res }),
      { action: "session:create", resourceType: "session", resourceId: "new" },
    );
    expect(failed).toEqual({ ok: false });
    expect(audited.status()).toBe(400);
    expect((await plane.listAuditLogs()).items).toHaveLength(1);

    const closed = fakeRes();
    const throwing = new ControlPlane();
    vi.spyOn(throwing, "appendAuditLog").mockRejectedValue(new Error("audit"));
    const closedResult = await readJsonBodyWithAudit(
      ctx({ plane: throwing, req: fakeReq("{bad"), res: closed.res }),
      { action: "session:create", resourceType: "session", resourceId: "new" },
    );
    expect(closedResult).toEqual({ ok: false });
    expect(closed.status()).toBe(500);
  });

  it("hides out-of-scope repositories and couples mutation audits", async () => {
    const hidden = fakeRes();
    sendHiddenNotFound(hidden.res);
    expect(hidden.json()).toEqual({ error: { code: "NOT_FOUND", message: "resource not found" } });
    const denied = fakeRes();
    denyRepositoryScope(ctx({ res: denied.res }));
    expect(denied.json()).toEqual({ error: { code: "NOT_FOUND", message: "resource not found" } });

    const scoped = ctx({
      res: fakeRes().res,
      principal: {
        id: "user",
        username: "user",
        role: "operator",
        kind: "user",
        allowedRepositoryIds: ["repo-a"],
      },
    });
    expect(repositoryInScope(scoped, "repo-a")).toBe(true);
    expect(repositoryInScope(scoped, "repo-b")).toBe(false);
    expect(repositoryInScope(ctx({ res: fakeRes().res }), "repo-b")).toBe(true);

    const extra = fakeRes();
    sendRouteError(extra.res, 409, "CONFLICT", "busy", { operationId: "op-1" });
    expect(extra.json()).toEqual({
      error: { code: "CONFLICT", message: "busy", operationId: "op-1" },
    });

    const plane = new ControlPlane();
    expect(
      await commitMutationAudit(ctx({ plane, res: fakeRes().res }), {
        action: "provider:create",
        resourceType: "provider",
        resourceId: "p1",
      }),
    ).toBe(true);
    const throwing = new ControlPlane();
    vi.spyOn(throwing, "appendAuditLog").mockRejectedValue(new Error("audit"));
    const failedRes = fakeRes();
    expect(
      await commitMutationAudit(ctx({ plane: throwing, res: failedRes.res }), {
        action: "provider:create",
        resourceType: "provider",
        resourceId: "p1",
      }),
    ).toBe(false);
    expect(failedRes.status()).toBe(500);
  });
});
