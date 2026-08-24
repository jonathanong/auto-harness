/* eslint-disable max-lines -- one-time ticket store, replay, and expiry share one fixture. */
import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import type { AuthStorage } from "./auth-accounts.ts";
import type { ViewerTicketRecord } from "./db/plane-storage-types.ts";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

function authService(now?: () => number): AuthService {
  return new AuthService({
    mode: "required",
    secret: "a".repeat(32),
    admins: admins(),
    ...(now ? { now } : {}),
  });
}

describe("one-time viewer tickets", () => {
  it("rejects service-account cookie and ticket minting", async () => {
    const auth = authService();
    const service = await auth.createServiceAccount({ name: "ci", role: "operator" });
    expect(() =>
      auth.issueCookie({ setHeader: () => undefined } as never, service.account),
    ).toThrow("session cookies are only available to browser accounts");
    await expect(auth.issueViewerTicket(service.account)).rejects.toThrow(
      "viewer tickets are only available to browser sessions",
    );
  });

  it("consumes an opaque ticket once and rejects replay", async () => {
    const auth = authService();
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    const ticket = await auth.issueViewerTicket(user);
    expect(ticket.includes(".")).toBe(false);
    expect(await auth.authenticateViewerTicket(ticket)).toMatchObject(user);
    expect(await auth.authenticateViewerTicket(ticket)).toBeNull();
    expect(await auth.authenticateViewerTicket("")).toBeNull();
  });

  it("lets exactly one concurrent consume succeed", async () => {
    const auth = authService();
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    const ticket = await auth.issueViewerTicket(user);
    const results = await Promise.all([
      auth.authenticateViewerTicket(ticket),
      auth.authenticateViewerTicket(ticket),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((principal) => principal === null)).toHaveLength(1);
  });

  it("expires tickets after 60 seconds", async () => {
    let now = 1_000_000;
    const auth = authService(() => now);
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    const ticket = await auth.issueViewerTicket(user);
    now += 60_000;
    expect(await auth.authenticateViewerTicket(ticket)).toBeNull();
  });

  it("drops expired in-memory tickets when issuing a new one", async () => {
    let now = 1_000_000;
    const auth = authService(() => now);
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    const expired = await auth.issueViewerTicket(user);
    now += 60_000;
    const next = await auth.issueViewerTicket(user);
    expect(await auth.authenticateViewerTicket(expired)).toBeNull();
    expect(await auth.authenticateViewerTicket(next)).toMatchObject(user);
  });

  it("stores hashed tickets in durable storage and consumes them there", async () => {
    const tickets = new Map<string, ViewerTicketRecord>();
    const storage = {
      listAuthAccounts: async () => [],
      putAuthAccount: async () => undefined,
      deleteAuthAccount: async () => undefined,
      putViewerTicket: async (record: ViewerTicketRecord) => {
        if (tickets.has(record.ticketHash)) {
          throw Object.assign(new Error("collision"), { name: "ConditionalCheckFailedException" });
        }
        tickets.set(record.ticketHash, record);
      },
      consumeViewerTicket: async (ticketHash: string, nowMs: number) => {
        const stored = tickets.get(ticketHash);
        if (!stored) return null;
        tickets.delete(ticketHash);
        return stored.expiresAtMs <= nowMs ? null : stored;
      },
    } satisfies AuthStorage;
    const auth = authService();
    await auth.hydrate(storage);
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    const ticket = await auth.issueViewerTicket(user);
    expect(tickets.size).toBe(1);
    expect([...tickets.keys()][0]).not.toBe(ticket);
    expect(await auth.authenticateViewerTicket(ticket)).toMatchObject(user);
    expect(tickets.size).toBe(0);
  });

  it("retries a colliding hash then succeeds", async () => {
    let attempts = 0;
    const tickets = new Map<string, ViewerTicketRecord>();
    const storage = {
      listAuthAccounts: async () => [],
      putAuthAccount: async () => undefined,
      deleteAuthAccount: async () => undefined,
      putViewerTicket: async (record: ViewerTicketRecord) => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("collision"), { name: "ConditionalCheckFailedException" });
        }
        tickets.set(record.ticketHash, record);
      },
      consumeViewerTicket: async (ticketHash: string, nowMs: number) => {
        const stored = tickets.get(ticketHash);
        if (!stored) return null;
        tickets.delete(ticketHash);
        return stored.expiresAtMs <= nowMs ? null : stored;
      },
    } satisfies AuthStorage;
    const auth = authService();
    await auth.hydrate(storage);
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    const ticket = await auth.issueViewerTicket(user);
    expect(attempts).toBe(2);
    expect(await auth.authenticateViewerTicket(ticket)).toMatchObject(user);
  });

  it("retries a colliding hash then fails closed", async () => {
    const storage = {
      listAuthAccounts: async () => [],
      putAuthAccount: async () => undefined,
      deleteAuthAccount: async () => undefined,
      putViewerTicket: async () => {
        throw Object.assign(new Error("collision"), { name: "ConditionalCheckFailedException" });
      },
      consumeViewerTicket: async () => null,
    } satisfies AuthStorage;
    const auth = authService();
    await auth.hydrate(storage);
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    await expect(auth.issueViewerTicket(user)).rejects.toThrow("unable to issue viewer ticket");
  });

  it("propagates durable ticket persistence failures", async () => {
    const storage = {
      listAuthAccounts: async () => [],
      putAuthAccount: async () => undefined,
      deleteAuthAccount: async () => undefined,
      putViewerTicket: async () => {
        throw new Error("dynamo unavailable");
      },
      consumeViewerTicket: async () => null,
    } satisfies AuthStorage;
    const auth = authService();
    await auth.hydrate(storage);
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    await expect(auth.issueViewerTicket(user)).rejects.toThrow("dynamo unavailable");
  });

  it("rejects a ticket after the account is deleted", async () => {
    const auth = authService();
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    const ticket = await auth.issueViewerTicket(user);
    await auth.deleteUser("alice");
    expect(await auth.authenticateViewerTicket(ticket)).toBeNull();
  });

  it("rejects a ticket whose stored claims no longer match the live account", async () => {
    const tickets = new Map<string, ViewerTicketRecord>();
    const storage = {
      listAuthAccounts: async () => [],
      putAuthAccount: async () => undefined,
      deleteAuthAccount: async () => undefined,
      putViewerTicket: async (record: ViewerTicketRecord) => {
        tickets.set(record.ticketHash, record);
      },
      consumeViewerTicket: async (ticketHash: string) => tickets.get(ticketHash) ?? null,
    } satisfies AuthStorage;
    const auth = authService();
    await auth.hydrate(storage);
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
      allowedRepositoryIds: ["repo-a"],
    });
    const ticket = await auth.issueViewerTicket(user);
    const stored = [...tickets.values()][0]!;
    stored.principal = { ...stored.principal, allowedRepositoryIds: ["repo-b"] };
    expect(await auth.authenticateViewerTicket(ticket)).toBeNull();
  });

  it("keeps tickets in memory when durable ticket methods are incomplete", async () => {
    const auth = authService();
    await auth.hydrate({
      listAuthAccounts: async () => [],
      putAuthAccount: async () => undefined,
      deleteAuthAccount: async () => undefined,
      putViewerTicket: async () => undefined,
    });
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    const ticket = await auth.issueViewerTicket(user);
    expect(await auth.authenticateViewerTicket(ticket)).toMatchObject(user);
  });

  it("treats an in-memory hash collision as a failed conditional write", async () => {
    const auth = authService();
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    const persist = (
      auth as unknown as { persistViewerTicket: (record: ViewerTicketRecord) => Promise<void> }
    ).persistViewerTicket.bind(auth);
    const record = {
      ticketHash: "duplicate",
      principal: {
        id: user.id,
        username: user.username,
        role: user.role,
        kind: "user" as const,
      },
      expiresAtMs: Date.now() + 60_000,
    };
    await persist(record);
    await expect(persist(record)).rejects.toMatchObject({
      name: "ConditionalCheckFailedException",
    });
  });
});
