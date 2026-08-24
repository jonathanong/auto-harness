import { describe, expect, it, vi } from "vitest";

import { createDynamoClients, tableNames } from "./dynamo.ts";
import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";
import { DynamoPlaneStorage } from "./plane-storage.ts";
import { consumeViewerTicket, putViewerTicket } from "./plane-storage-viewer-tickets.ts";
import type { PlaneStorageCtx, ViewerTicketRecord } from "./plane-storage-types.ts";

const dynamo = createDynamoTestCtx("ViewerTix");

const principal: ViewerTicketRecord["principal"] = {
  id: "user:alice",
  username: "alice",
  role: "operator",
  kind: "user",
  allowedRepositoryIds: ["repo-a"],
};

function record(ticketHash = "hash-1", expiresAtMs = 2_000): ViewerTicketRecord {
  return { ticketHash, principal, expiresAtMs };
}

function ctx(send: ReturnType<typeof vi.fn>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: { viewerTickets: "ViewerTickets" } as never,
  };
}

const conditional = Object.assign(new Error("lost"), {
  name: "ConditionalCheckFailedException",
});

describe("durable viewer tickets", () => {
  it("lets exactly one concurrent consume succeed", async () => {
    if (!dynamo.available || !dynamo.storage) return;
    const { doc } = createDynamoClients();
    const second = new DynamoPlaneStorage(doc, tableNames(dynamo.prefix));
    const stored = record("concurrent-hash", Date.now() + 60_000);
    await dynamo.storage.putViewerTicket(stored);
    const results = await Promise.all([
      dynamo.storage.consumeViewerTicket(stored.ticketHash, Date.now()),
      second.consumeViewerTicket(stored.ticketHash, Date.now()),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((value) => value === null)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({ principal });
  });

  it("rejects expired tickets after a successful delete", async () => {
    const send = vi.fn().mockResolvedValue({
      Attributes: {
        ticketHash: "hash-1",
        expiresAtMs: 1_000,
        id: principal.id,
        username: principal.username,
        role: principal.role,
        kind: principal.kind,
      },
    });
    await expect(
      new DynamoPlaneStorage(
        { send } as never,
        {
          viewerTickets: "ViewerTickets",
        } as never,
      ).consumeViewerTicket("hash-1", 1_000),
    ).resolves.toBeNull();
    await expect(consumeViewerTicket(ctx(send), "hash-1", 1_000)).resolves.toBeNull();
  });

  it("returns null when the consume condition loses the race", async () => {
    await expect(
      consumeViewerTicket(ctx(vi.fn().mockRejectedValue(conditional)), "hash-1", 1),
    ).resolves.toBeNull();
  });

  it("propagates non-conditional consume failures", async () => {
    await expect(
      consumeViewerTicket(
        ctx(vi.fn().mockRejectedValue(new Error("dynamo unavailable"))),
        "hash-1",
        1,
      ),
    ).rejects.toThrow("dynamo unavailable");
  });

  it("drops malformed stored principals", async () => {
    const send = vi.fn().mockResolvedValue({
      Attributes: {
        ticketHash: "hash-1",
        expiresAtMs: 2_000,
        id: principal.id,
        username: principal.username,
        role: "not-a-role",
        kind: "user",
      },
    });
    await expect(consumeViewerTicket(ctx(send), "hash-1", 1)).resolves.toBeNull();
    send.mockResolvedValueOnce({
      Attributes: {
        ticketHash: "hash-1",
        expiresAtMs: 2_000,
        id: principal.id,
        username: principal.username,
        role: principal.role,
        kind: "service-account",
      },
    });
    await expect(consumeViewerTicket(ctx(send), "hash-1", 1)).resolves.toBeNull();
    send.mockResolvedValueOnce({
      Attributes: {
        ticketHash: "hash-1",
        expiresAtMs: 2_000,
        id: principal.id,
        username: principal.username,
        role: principal.role,
        kind: "user",
        allowedRepositoryIds: [1],
      },
    });
    await expect(consumeViewerTicket(ctx(send), "hash-1", 1)).resolves.toBeNull();
    send.mockResolvedValueOnce({
      Attributes: {
        ticketHash: "hash-1",
        expiresAtMs: 2_000,
        id: principal.id,
        username: principal.username,
        role: principal.role,
        kind: "user",
        boundHostId: 4,
      },
    });
    await expect(consumeViewerTicket(ctx(send), "hash-1", 1)).resolves.toBeNull();
    send.mockResolvedValueOnce({ Attributes: { expiresAtMs: 2_000 } });
    await expect(consumeViewerTicket(ctx(send), "hash-1", 1)).resolves.toBeNull();
    send.mockResolvedValueOnce({});
    await expect(consumeViewerTicket(ctx(send), "hash-1", 1)).resolves.toBeNull();
  });

  it("returns a valid stored principal including optional scope fields", async () => {
    const send = vi.fn().mockResolvedValue({
      Attributes: {
        ticketHash: "hash-1",
        expiresAtMs: 2_000,
        id: principal.id,
        username: principal.username,
        role: principal.role,
        kind: "user",
        allowedRepositoryIds: ["repo-a"],
        boundHostId: "host-a",
      },
    });
    await expect(consumeViewerTicket(ctx(send), "hash-1", 1)).resolves.toEqual({
      ticketHash: "hash-1",
      expiresAtMs: 2_000,
      principal: { ...principal, boundHostId: "host-a" },
    });
  });

  it("writes hashed tickets with a collision condition", async () => {
    const send = vi.fn().mockResolvedValue({});
    await new DynamoPlaneStorage(
      { send } as never,
      {
        viewerTickets: "ViewerTickets",
      } as never,
    ).putViewerTicket(record());
    await putViewerTicket(ctx(send), record());
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      TableName: "ViewerTickets",
      ConditionExpression: "attribute_not_exists(ticketHash)",
      Item: {
        ticketHash: "hash-1",
        expiresAtMs: 2_000,
        id: principal.id,
        kind: "user",
        allowedRepositoryIds: ["repo-a"],
      },
    });
    expect(send.mock.calls[0]?.[0].input.Item).not.toHaveProperty("boundHostId");
    await putViewerTicket(ctx(send), {
      ...record("hash-2"),
      principal: { ...principal, boundHostId: "host-a" },
    });
    expect(send.mock.calls[2]?.[0].input.Item).toMatchObject({ boundHostId: "host-a" });
    await putViewerTicket(ctx(send), {
      ...record("hash-3"),
      principal: {
        id: principal.id,
        username: principal.username,
        role: principal.role,
        kind: "user",
      },
    });
    expect(send.mock.calls[3]?.[0].input.Item).not.toHaveProperty("allowedRepositoryIds");
  });
});
