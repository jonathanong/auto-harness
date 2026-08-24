import { describe, expect, it } from "vitest";

import { AuthService, cacheTtlFromEnv } from "./auth.ts";
import type { AuthAccountRecord } from "./db/plane-storage.ts";

/**
 * Two AuthService instances over one shared store stand in for two API workers. hydrate()
 * ran once per cold start on the REST path, so a worker kept honouring a revoked API key
 * — and rejecting a freshly created one — until its container recycled.
 */
class SharedAccountStore {
  readonly records = new Map<string, AuthAccountRecord>();
  listCalls = 0;

  async listAuthAccounts(): Promise<AuthAccountRecord[]> {
    this.listCalls += 1;
    return [...this.records.values()];
  }
  async putAuthAccount(record: AuthAccountRecord): Promise<void> {
    this.records.set(record.id, record);
  }
  async deleteAuthAccount(id: string): Promise<void> {
    this.records.delete(id);
  }
}

function clock(start = 1_000) {
  let value = start;
  return { now: () => value, advance: (ms: number) => (value += ms) };
}

async function workers(cacheTtlMs: number, now: () => number) {
  const storage = new SharedAccountStore();
  const options = { mode: "required" as const, secret: "a".repeat(32), admins: adminsBlob() };
  const writer = new AuthService({ ...options, cacheTtlMs, now });
  const reader = new AuthService({ ...options, cacheTtlMs, now });
  await writer.hydrate(storage);
  await reader.hydrate(storage);
  return { storage, writer, reader };
}

function adminsBlob(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

describe("auth account cache staleness", () => {
  it("accepts a key created on another worker without waiting for the TTL", async () => {
    const time = clock();
    const { storage, writer, reader } = await workers(30_000, time.now);

    const { apiKey } = await writer.createServiceAccount(
      { name: "agent", role: "operator" },
      storage,
    );

    // No time has passed, so only the cache-miss path can find this.
    expect(await reader.authenticateApiKey(apiKey)).toMatchObject({ username: "agent" });
  });

  it("stops accepting a key revoked on another worker once the TTL passes", async () => {
    const time = clock();
    const { storage, writer, reader } = await workers(30_000, time.now);
    const created = await writer.createServiceAccount({ name: "agent", role: "operator" }, storage);
    expect(await reader.authenticateApiKey(created.apiKey)).not.toBeNull();

    await writer.deleteServiceAccount(created.account.id, storage);
    time.advance(30_001);

    expect(await reader.authenticateApiKey(created.apiKey)).toBeNull();
  });

  it("revokes a cookie issued for an account deleted on another worker", async () => {
    const time = clock();
    const { storage, writer, reader } = await workers(30_000, time.now);
    const created = await writer.createUser(
      { username: "alice", password: "password", role: "operator" },
      storage,
    );
    let cookie = "";
    writer.issueCookie(
      { setHeader: (_name: string, value: string) => (cookie = value) } as never,
      created,
    );
    const header = { cookie: cookie.split(";")[0]! };
    expect(await reader.authenticate({ headers: header } as never)).not.toBeNull();

    await writer.deleteUser("alice", storage);
    time.advance(30_001);

    expect(await reader.authenticate({ headers: header } as never)).toBeNull();
  });

  it("does not re-read the store once per request", async () => {
    const time = clock();
    const { storage, writer, reader } = await workers(30_000, time.now);
    const created = await writer.createServiceAccount({ name: "agent", role: "operator" }, storage);
    await reader.authenticateApiKey(created.apiKey);
    const settled = storage.listCalls;

    for (let i = 0; i < 25; i += 1) await reader.authenticateApiKey(created.apiKey);

    expect(storage.listCalls).toBe(settled);
  });

  it("rate-limits the cache-miss refresh so unknown keys cannot drive a read each time", async () => {
    const time = clock();
    const { storage, reader } = await workers(30_000, time.now);
    const before = storage.listCalls;

    for (let i = 0; i < 25; i += 1) await reader.authenticateApiKey(`hns_bogus-${i}`);

    // One refresh for the first miss; the rest fall inside the miss interval.
    expect(storage.listCalls - before).toBe(1);
  });
});

describe("cacheTtlFromEnv", () => {
  it("defaults when unset and accepts a non-negative integer", () => {
    expect(cacheTtlFromEnv(undefined)).toBe(30_000);
    expect(cacheTtlFromEnv("")).toBe(30_000);
    expect(cacheTtlFromEnv("0")).toBe(0);
    expect(cacheTtlFromEnv("5000")).toBe(5_000);
  });

  it("rejects values that would silently disable the bound", () => {
    expect(() => cacheTtlFromEnv("-1")).toThrow(/non-negative integer/);
    expect(() => cacheTtlFromEnv("1.5")).toThrow(/non-negative integer/);
    expect(() => cacheTtlFromEnv("soon")).toThrow(/non-negative integer/);
  });
});
