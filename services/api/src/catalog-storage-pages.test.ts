import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { encodeStorageCursor, InvalidListPageQueryError } from "./control-plane-id-page.ts";
import { listCommandsPage, listProvidersPage } from "./db/plane-storage-catalog-providers.ts";
import type { PlaneStorageCtx } from "./db/plane-storage-types.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

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
    await expect(
      plane.listProvidersPageDurable({ limit: 1, cursor: providers.nextCursor }),
    ).resolves.toMatchObject({ items: [{ id: "p-2" }], nextCursor: null });
  });

  it("returns a storage page and rejects an invalid limit on GET /commands", async () => {
    const listCommandsFromStorage = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: "c-1" }], nextKey: { id: "c-1" } })
      .mockResolvedValueOnce({ items: [{ id: "c-2" }], nextKey: null });
    const listProvidersFromStorage = vi.fn(async () => ({ items: [{ id: "p-1" }], nextKey: null }));
    const plane = new ControlPlane({
      storage: {
        listCommandsPage: listCommandsFromStorage,
        listProvidersPage: listProvidersFromStorage,
      } as never,
    });
    const { handler } = createLocalApp({ plane });
    const ok = await invokeHandler(handler as never, "GET", "/api/v1/commands?limit=1");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      items: [{ id: "c-1" }],
      nextCursor: expect.stringMatching(/^s1\./),
    });
    const next = await invokeHandler(
      handler as never,
      "GET",
      `/api/v1/commands?limit=1&cursor=${ok.json.nextCursor}`,
    );
    expect(next.status).toBe(200);
    expect(next.json).toMatchObject({ items: [{ id: "c-2" }], nextCursor: null });
    expect(
      (await invokeHandler(handler as never, "GET", "/api/v1/commands?limit=foo")).status,
    ).toBe(400);
    expect(
      (await invokeHandler(handler as never, "GET", "/api/v1/providers?limit=foo")).status,
    ).toBe(400);
    await expect(
      invokeHandler(handler as never, "GET", "/api/v1/providers"),
    ).resolves.toMatchObject({
      status: 200,
      json: { items: [{ id: "p-1" }], nextCursor: null },
    });
  });

  it("pages providers through a storage start key", async () => {
    const listProvidersFromStorage = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: "p-1" }], nextKey: { id: "p-1" } })
      .mockResolvedValueOnce({ items: [{ id: "p-2" }], nextKey: null });
    const plane = new ControlPlane({
      storage: {
        listProvidersPage: listProvidersFromStorage,
      } as never,
    });
    const first = await plane.listProvidersPageDurable({ limit: 1, cursor: null });
    expect(first.items.map((provider) => provider.id)).toEqual(["p-1"]);
    expect(first.nextCursor).toMatch(/^s1\./);
    await expect(
      plane.listProvidersPageDurable({ limit: 1, cursor: first.nextCursor }),
    ).resolves.toMatchObject({ items: [{ id: "p-2" }], nextCursor: null });
    expect(listProvidersFromStorage).toHaveBeenCalledTimes(2);
  });

  it("rejects a storage cursor that is not a catalog id key", async () => {
    const listCommandsFromStorage = vi.fn(async () => ({ items: [], nextKey: null }));
    const plane = new ControlPlane({
      storage: {
        listCommandsPage: listCommandsFromStorage,
        listProvidersPage: listCommandsFromStorage,
      } as never,
    });
    const secret = plane.state.sessionCursorSecret;
    const commandsScope = { hostId: null, repositoryId: null, kind: "commands" as const };
    const providersScope = { hostId: null, repositoryId: null, kind: "providers" as const };
    await expect(
      plane.listCommandsPageDurable({
        limit: 1,
        cursor: encodeStorageCursor({}, secret, commandsScope),
      }),
    ).rejects.toThrow(InvalidListPageQueryError);
    await expect(
      plane.listProvidersPageDurable({
        limit: 1,
        cursor: encodeStorageCursor({ id: 1 }, secret, providersScope),
      }),
    ).rejects.toThrow(InvalidListPageQueryError);
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane }).handler as never,
          "GET",
          `/api/v1/commands?cursor=${encodeStorageCursor({ id: "" }, secret, commandsScope)}`,
        )
      ).status,
    ).toBe(400);
    const commandsCursor = encodeStorageCursor({ id: "c-1" }, secret, commandsScope);
    await expect(
      plane.listProvidersPageDurable({ limit: 1, cursor: commandsCursor }),
    ).rejects.toThrow(InvalidListPageQueryError);
    expect(listCommandsFromStorage).not.toHaveBeenCalled();
  });
});
