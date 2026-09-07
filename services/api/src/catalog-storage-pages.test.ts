import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { InvalidListPageQueryError } from "./control-plane-id-page.ts";
import { listCommandsPage, listProvidersPage } from "./db/plane-storage-catalog-providers.ts";
import type { PlaneStorageCtx } from "./db/plane-storage-types.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

function opaqueCursor(body: unknown): string {
  return `s1.${Buffer.from(JSON.stringify(body), "utf8").toString("base64url")}`;
}

describe("catalog storage pages", () => {
  it("pages commands and providers from a bounded Scan", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [{ id: "a" }, { id: "b" }],
      LastEvaluatedKey: { id: "b" },
    });
    const ctx = {
      doc: { send },
      tables: { commands: "Commands", providers: "Providers" },
    } as unknown as PlaneStorageCtx;
    await expect(listCommandsPage(ctx, { limit: 1 })).resolves.toEqual({
      items: [{ id: "a" }],
      nextKey: { id: "a" },
    });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ TableName: "Commands", Limit: 2 });
    send.mockResolvedValueOnce({ Items: [{ id: "p" }] });
    await expect(listProvidersPage(ctx, { limit: 5, startKey: { id: "prev" } })).resolves.toEqual({
      items: [{ id: "p" }],
      nextKey: null,
    });
  });

  it("pages in-memory commands and providers by id", async () => {
    const plane = new ControlPlane();
    plane.createCommand({ id: "c-2", name: "two", argv: ["echo"], providerId: null });
    plane.createCommand({ id: "c-1", name: "one", argv: ["echo"], providerId: null });
    const first = await plane.listCommandsPageDurable({ limit: 1, cursor: null });
    expect(first.items.map((command) => command.id)).toEqual(["c-1"]);
    expect(first.nextCursor).toBe("c-1");
    const second = await plane.listCommandsPageDurable({ limit: 1, cursor: first.nextCursor });
    expect(second.items.map((command) => command.id)).toEqual(["c-2"]);
    expect(second.nextCursor).toBeNull();

    plane.createProvider({ id: "p-2", name: "two" });
    plane.createProvider({ id: "p-1", name: "one" });
    const providers = await plane.listProvidersPageDurable({ limit: 1, cursor: null });
    expect(providers.items.map((provider) => provider.id)).toEqual(["p-1"]);
    expect(providers.nextCursor).toBe("p-1");
  });

  it("returns a storage page and rejects an invalid limit on GET /commands", async () => {
    const listCommandsFromStorage = vi.fn(async () => ({
      items: [{ id: "c-1" }],
      nextKey: { id: "c-1" },
    }));
    const plane = new ControlPlane({
      storage: { listCommandsPage: listCommandsFromStorage } as never,
    });
    const { handler } = createLocalApp({ plane });
    const ok = await invokeHandler(handler as never, "GET", "/api/v1/commands?limit=1");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      items: [{ id: "c-1" }],
      nextCursor: expect.stringMatching(/^s1\./),
    });
    expect(
      (await invokeHandler(handler as never, "GET", "/api/v1/commands?limit=foo")).status,
    ).toBe(400);

    const listProvidersFromStorage = vi.fn(async () => ({ items: [{ id: "p-1" }], nextKey: null }));
    const providers = new ControlPlane({
      storage: { listProvidersPage: listProvidersFromStorage } as never,
    });
    const app = createLocalApp({ plane: providers });
    expect(
      (await invokeHandler(app.handler as never, "GET", "/api/v1/providers?limit=foo")).status,
    ).toBe(400);
    await expect(
      invokeHandler(app.handler as never, "GET", "/api/v1/providers"),
    ).resolves.toMatchObject({ status: 200, json: { items: [{ id: "p-1" }], nextCursor: null } });
  });

  it("rejects a storage cursor that is not a catalog id key", async () => {
    const listCommandsFromStorage = vi.fn(async () => ({ items: [], nextKey: null }));
    const plane = new ControlPlane({
      storage: {
        listCommandsPage: listCommandsFromStorage,
        listProvidersPage: listCommandsFromStorage,
      } as never,
    });
    await expect(
      plane.listCommandsPageDurable({ limit: 1, cursor: opaqueCursor({}) }),
    ).rejects.toThrow(InvalidListPageQueryError);
    await expect(
      plane.listProvidersPageDurable({ limit: 1, cursor: opaqueCursor({ id: 1 }) }),
    ).rejects.toThrow(InvalidListPageQueryError);
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane }).handler as never,
          "GET",
          `/api/v1/commands?cursor=${opaqueCursor({ id: "" })}`,
        )
      ).status,
    ).toBe(400);
    expect(listCommandsFromStorage).not.toHaveBeenCalled();
  });
});
