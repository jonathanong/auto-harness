/* eslint-disable max-lines -- authentication and account lifecycle share one security boundary. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { isUserRole } from "@auto-harness/shared";
import bcrypt from "bcryptjs";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal, Role } from "./auth-types.ts";
export type { Principal } from "./auth-types.ts";
import {
  createServiceAccount,
  createUser,
  hashApiKey,
  hydrateAccounts,
  publicPrincipal,
  toUser,
  validateCredential,
  type AuthAccountDeleteFence,
  type FencedAuthAccountDelete,
  type AuthStorage,
  type ServiceAccount,
  type User,
} from "./auth-accounts.ts";
import type { ViewerTicketRecord } from "./db/plane-storage-types.ts";

export type AuthMode = "disabled" | "required";
const COOKIE = "auto_harness_session";
const DAY_MS = 24 * 60 * 60 * 1000;
const VIEWER_TICKET_MS = 60 * 1000;
/**
 * Upper bound on how long this process may keep serving a credential decision from its
 * account cache. hydrate() used to run once per cold start on the REST path, so a warm
 * worker accepted a revoked API key, and honoured a deleted user's cookie, until the
 * container recycled — minutes to hours.
 */
const DEFAULT_CACHE_TTL_MS = 30_000;
/**
 * Floor between cache-miss refreshes. An unknown key is usually a newly created account
 * this worker has not seen, and refetching makes it usable immediately — but without a
 * floor, a flood of invalid bearer tokens would drive one table scan per request.
 */
const MISS_REFRESH_INTERVAL_MS = 1_000;
// Keep password verification work comparable for unknown usernames.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("auto-harness-dummy-password", 12);

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function parseB64urlJson<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function asRole(value: unknown): Role | null {
  return isUserRole(value) ? value : null;
}

function parseAdmins(raw: string | undefined): User[] {
  if (!raw) return [];
  const decoded = parseB64urlJson<unknown>(raw);
  if (!Array.isArray(decoded)) throw new Error("HARNESS_ADMINS must be base64 JSON array");
  return decoded.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { username?: unknown }).username !== "string" ||
      typeof (item as { password?: unknown }).password !== "string"
    ) {
      throw new Error(`HARNESS_ADMINS entry ${index} is invalid`);
    }
    const { username, password } = item as { username: string; password: string };
    try {
      validateCredential(username, "username");
      validateCredential(password, "password");
    } catch {
      throw new Error(`HARNESS_ADMINS entry ${index} is invalid`);
    }
    return {
      id: `admin:${username}`,
      username,
      role: "admin",
      kind: "admin",
      passwordHash: bcrypt.hashSync(password, 12),
    };
  });
}

/**
 * Auth records are intentionally isolated from route handlers. Local mode keeps
 * them in memory; cloud persistence belongs in the control-plane storage layer.
 */
export class AuthService {
  readonly mode: AuthMode;
  private readonly secret: string;
  private readonly admins: User[];
  private readonly users = new Map<string, User>();
  private readonly serviceAccounts = new Map<string, ServiceAccount>();
  private storage: AuthStorage | undefined;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private lastMissRefreshAt = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<void> | undefined;
  private readonly memoryTickets = new Map<string, ViewerTicketRecord>();

  constructor(
    // `| undefined` on each field since callers commonly forward their own
    // already-optional options verbatim (e.g. LocalServerOptions.authMode).
    options: {
      mode?: AuthMode | undefined;
      secret?: string | undefined;
      admins?: string | undefined;
      cacheTtlMs?: number | undefined;
      now?: (() => number) | undefined;
    } = {},
  ) {
    this.mode = options.mode ?? authModeFromEnv();
    this.secret = options.secret ?? process.env.HARNESS_SESSION_SECRET ?? "";
    this.admins = parseAdmins(options.admins ?? process.env.HARNESS_ADMINS);
    this.cacheTtlMs = options.cacheTtlMs ?? cacheTtlFromEnv();
    this.now = options.now ?? Date.now;
    if (this.mode === "required" && (this.secret.length < 32 || this.admins.length === 0)) {
      throw new Error(
        "HARNESS_AUTH_MODE=required needs HARNESS_SESSION_SECRET (at least 32 characters) and HARNESS_ADMINS",
      );
    }
  }

  async hydrate(storage: AuthStorage | undefined): Promise<void> {
    await hydrateAccounts(storage, this.users, this.serviceAccounts);
    this.storage = storage;
    this.lastRefreshAt = this.now();
  }

  /**
   * Re-read accounts when this process's view may have gone stale.
   *
   * `reason: "miss"` means a credential was not found locally, which most often means a
   * newly created account: refresh eagerly so it becomes usable right away, but no more
   * than once per MISS_REFRESH_INTERVAL_MS so unknown tokens cannot amplify into a scan
   * per request. Otherwise refresh only once the cache passes its TTL, which is what
   * bounds how long a revoked credential keeps working.
   */
  private async refreshAccounts(reason: "hit" | "miss"): Promise<void> {
    const storage = this.storage;
    if (!storage) return;
    const now = this.now();
    // The miss floor is measured from the last miss-driven refresh, not from any refresh.
    // Measuring from the latter would let a recent hydrate suppress the very lookup this
    // path exists for: a key created moments ago on another worker.
    if (reason === "miss") {
      if (now - this.lastMissRefreshAt < MISS_REFRESH_INTERVAL_MS) return;
      this.lastMissRefreshAt = now;
    } else if (now - this.lastRefreshAt < this.cacheTtlMs) return;
    // Coalesce: concurrent requests past the threshold share one read.
    this.refreshing ??= hydrateAccounts(storage, this.users, this.serviceAccounts)
      .then(() => {
        this.lastRefreshAt = this.now();
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    await this.refreshing;
  }

  async createUser(
    input: { username: string; password: string; role: Role; allowedRepositoryIds?: string[] },
    storage?: AuthStorage,
  ): Promise<Principal> {
    return createUser(input, this.users, this.admins, storage);
  }

  listUsers(): Principal[] {
    return [...this.users.values()].map(publicPrincipal);
  }

  async deleteUser(username: string, storage?: AuthStorage): Promise<boolean> {
    const user = this.users.get(username);
    if (!user) return false;
    if (storage) await storage.deleteAuthAccount(user.id);
    return this.users.delete(username);
  }

  async deleteUserFenced(
    username: string,
    storage: AuthStorage | undefined,
    fence: AuthAccountDeleteFence | undefined,
  ): Promise<FencedAuthAccountDelete> {
    const user = this.users.get(username);
    if (!user) return "missing";
    if (fence) {
      if (!storage?.deleteAuthAccountFenced) return "fence-lost";
      const result = await storage.deleteAuthAccountFenced(user.id, fence);
      if (result === "fence-lost") return result;
      this.users.delete(username);
      return result;
    } else if (storage) {
      await storage.deleteAuthAccount(user.id);
    }
    this.users.delete(username);
    return "deleted";
  }

  /**
   * Change a durable user account's password after verifying the current
   * password. Bootstrap admins are intentionally environment-only and service
   * accounts use API keys, so neither may use this path.
   */
  async changePassword(
    principal: Principal,
    currentPassword: string,
    newPassword: string,
    storage = this.storage,
  ): Promise<
    | "changed"
    | "invalid-current-password"
    | "invalid-new-password"
    | "unsupported-account"
    | "missing-account"
    | "storage-unavailable"
  > {
    if (principal.kind !== "user") return "unsupported-account";
    const user = this.users.get(principal.username);
    if (!user || user.id !== principal.id) return "missing-account";
    const expectedPasswordHash = user.passwordHash;
    if (!(await bcrypt.compare(currentPassword, expectedPasswordHash)))
      return "invalid-current-password";
    try {
      validateCredential(newPassword, "new password");
    } catch {
      return "invalid-new-password";
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    if (storage) {
      if (!storage.updateAuthAccountPassword) return "storage-unavailable";
      const persisted = await storage.updateAuthAccountPassword(
        user.id,
        expectedPasswordHash,
        passwordHash,
        new Date().toISOString(),
      );
      if (!persisted) return "missing-account";
    }
    if (user.passwordHash !== expectedPasswordHash) return "missing-account";
    user.passwordHash = passwordHash;
    return "changed";
  }

  async createServiceAccount(
    input: {
      name: string;
      role: Role;
      allowedRepositoryIds?: string[];
      boundHostId?: string;
    },
    storage?: AuthStorage,
  ): Promise<{ account: Principal & { name: string; createdAt: string }; apiKey: string }> {
    if (!input.name) throw new Error("name is required");
    return createServiceAccount(input, this.serviceAccounts, storage);
  }

  listServiceAccounts(): Array<Principal & { name: string; createdAt: string }> {
    return [...this.serviceAccounts.values()].map((account) => ({
      ...publicPrincipal(account),
      name: account.name,
      createdAt: account.createdAt,
    }));
  }

  async deleteServiceAccount(id: string, storage?: AuthStorage): Promise<boolean> {
    if (!this.serviceAccounts.has(id)) return false;
    if (storage) await storage.deleteAuthAccount(id);
    return this.serviceAccounts.delete(id);
  }

  async deleteServiceAccountFenced(
    id: string,
    storage: AuthStorage | undefined,
    fence: AuthAccountDeleteFence | undefined,
  ): Promise<FencedAuthAccountDelete> {
    if (!this.serviceAccounts.has(id)) return "missing";
    if (fence) {
      if (!storage?.deleteAuthAccountFenced) return "fence-lost";
      const result = await storage.deleteAuthAccountFenced(id, fence);
      if (result === "fence-lost") return result;
      this.serviceAccounts.delete(id);
      return result;
    } else if (storage) {
      await storage.deleteAuthAccount(id);
    }
    this.serviceAccounts.delete(id);
    return "deleted";
  }

  async authenticate(req: IncomingMessage): Promise<Principal | null> {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`));
    if (cookie) {
      const principal = await this.verifySession(cookie.slice(COOKIE.length + 1));
      if (principal) return principal;
    }
    const authorization = req.headers.authorization;
    if (!authorization) return null;
    if (authorization.startsWith("Bearer ")) return this.authenticateApiKey(authorization.slice(7));
    if (!authorization.startsWith("Basic ")) return null;
    try {
      const credentials = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = credentials.indexOf(":");
      const username = separator < 0 ? credentials : credentials.slice(0, separator);
      const password = separator < 0 ? "" : credentials.slice(separator + 1);
      if (!username || !password) return null;
      return this.authenticatePassword(username, password);
    } catch {
      return null;
    }
  }

  async authenticatePassword(username: string, password: string): Promise<Principal | null> {
    let user = this.admins.find((candidate) => candidate.username === username);
    if (!user) {
      const cached = this.users.get(username);
      const readAccount =
        cached && this.storage?.getAuthAccount
          ? () => this.storage!.getAuthAccount!(cached.id)
          : this.storage?.getAuthAccountByUsername
            ? () => this.storage!.getAuthAccountByUsername!(username)
            : undefined;
      const record = readAccount ? await readAccount() : undefined;
      if (record !== undefined) {
        if (record?.kind === "user" && record.username === username && record.passwordHash) {
          user = toUser(record);
          this.users.set(username, user);
        } else {
          this.users.delete(username);
        }
      } else {
        user = cached;
      }
    }
    const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    return user && valid ? publicPrincipal(user) : null;
  }

  async authenticateApiKey(key: string): Promise<Principal | null> {
    if (!key) return null;
    const hash = hashApiKey(key);
    await this.refreshAccounts("hit");
    const found = this.matchApiKey(hash);
    if (found) return found;
    // Unknown here usually means an account created on another worker. Before rejecting,
    // give the cache one bounded chance to catch up; otherwise a brand-new key's success
    // would depend on which worker answered.
    await this.refreshAccounts("miss");
    return this.matchApiKey(hash);
  }

  private matchApiKey(hash: string): Principal | null {
    for (const account of this.serviceAccounts.values()) {
      if (account.keyHash.length !== hash.length) continue;
      if (timingSafeEqual(Buffer.from(hash), Buffer.from(account.keyHash)))
        return publicPrincipal(account);
    }
    return null;
  }

  issueCookie(res: ServerResponse, principal: Principal): void {
    if (!isBrowserPrincipal(principal)) {
      throw new Error("session cookies are only available to browser accounts");
    }
    const header = { alg: "HS256", typ: "JWT" };
    const payload = { ...principal, exp: Math.floor((Date.now() + DAY_MS) / 1000) };
    const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = createHmac("sha256", this.secret).update(unsigned).digest("base64url");
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${unsigned}.${signature}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`,
    );
  }

  clearCookie(res: ServerResponse): void {
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  }

  /** Short-lived one-time browser-to-API WebSocket credential; never stored in JavaScript cookies. */
  async issueViewerTicket(principal: Principal): Promise<string> {
    if (!isBrowserPrincipal(principal)) {
      throw new Error("viewer tickets are only available to browser sessions");
    }
    const storedPrincipal = browserPrincipal(principal);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ticket = randomBytes(32).toString("base64url");
      const ticketHash = hashViewerTicket(ticket);
      const record: ViewerTicketRecord = {
        ticketHash,
        principal: storedPrincipal,
        expiresAtMs: this.now() + VIEWER_TICKET_MS,
      };
      try {
        await this.persistViewerTicket(record);
        return ticket;
      } catch (error) {
        if (isTicketHashCollision(error)) continue;
        throw error;
      }
    }
    throw new Error("unable to issue viewer ticket");
  }

  async authenticateViewerTicket(token: string): Promise<Principal | null> {
    if (!token) return null;
    const consumed = await this.consumeViewerTicket(hashViewerTicket(token));
    if (!consumed) return null;
    return this.bindCurrentPrincipal(consumed.principal);
  }

  private async persistViewerTicket(record: ViewerTicketRecord): Promise<void> {
    const storage = this.viewerTicketStorage();
    if (storage) {
      await storage.putViewerTicket(record);
      return;
    }
    this.sweepMemoryTickets();
    if (this.memoryTickets.has(record.ticketHash)) {
      throw Object.assign(new Error("viewer ticket hash collision"), {
        name: "ConditionalCheckFailedException",
      });
    }
    this.memoryTickets.set(record.ticketHash, record);
  }

  private async consumeViewerTicket(ticketHash: string): Promise<ViewerTicketRecord | null> {
    const storage = this.viewerTicketStorage();
    if (storage) return storage.consumeViewerTicket(ticketHash, this.now());
    const stored = this.memoryTickets.get(ticketHash);
    if (!stored) return null;
    this.memoryTickets.delete(ticketHash);
    return stored.expiresAtMs <= this.now() ? null : stored;
  }

  private viewerTicketStorage():
    | Required<Pick<AuthStorage, "putViewerTicket" | "consumeViewerTicket">>
    | undefined {
    const storage = this.storage;
    if (!storage?.putViewerTicket || !storage.consumeViewerTicket) return undefined;
    return storage as Required<Pick<AuthStorage, "putViewerTicket" | "consumeViewerTicket">>;
  }

  private sweepMemoryTickets(): void {
    const now = this.now();
    for (const [ticketHash, stored] of this.memoryTickets) {
      if (stored.expiresAtMs <= now) this.memoryTickets.delete(ticketHash);
    }
  }

  private async verifySession(token: string): Promise<Principal | null> {
    const parts = token.split(".");
    if (parts.length !== 3 || !this.secret) return null;
    const [header, payload, signature] = parts as [string, string, string];
    if (!header || !payload || !signature) return null;
    const expected = createHmac("sha256", this.secret)
      .update(`${header}.${payload}`)
      .digest("base64url");
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return null;
    const parsedHeader = parseB64urlJson<{ alg?: unknown; typ?: unknown }>(header);
    const value = parseB64urlJson<Principal & { exp?: unknown; audience?: unknown }>(payload);
    const role = value && asRole(value.role);
    if (
      !parsedHeader ||
      parsedHeader.alg !== "HS256" ||
      parsedHeader.typ !== "JWT" ||
      !value ||
      !role ||
      typeof value.id !== "string" ||
      typeof value.username !== "string" ||
      typeof value.exp !== "number" ||
      value.exp <= Date.now() / 1000
    )
      return null;
    if (!isBrowserPrincipal(value) || value.audience !== undefined) return null;
    return this.bindCurrentPrincipal(value);
  }

  private async bindCurrentPrincipal(value: Principal): Promise<Principal | null> {
    // Re-bind to live account state. This is the check that makes a cookie revocable, so
    // it must not be answered from a cache that outlived the account.
    await this.refreshAccounts("hit");
    let current = this.findCurrentPrincipal(value);
    if (!current) {
      await this.refreshAccounts("miss");
      current = this.findCurrentPrincipal(value);
    }
    const {
      exp: _exp,
      audience: _audience,
      ...claims
    } = value as Principal & {
      exp?: unknown;
      audience?: unknown;
    };
    if (!current || !isBrowserPrincipal(current) || !samePrincipalClaims(current, claims)) {
      return null;
    }
    return current;
  }

  private findCurrentPrincipal(value: Principal): Principal | null {
    if (value.kind === "admin") {
      const admin = this.admins.find((candidate) => candidate.id === value.id);
      return admin ? publicPrincipal(admin) : null;
    }
    if (value.kind === "user") {
      const user = this.users.get(value.username);
      return user && user.id === value.id ? publicPrincipal(user) : null;
    }
    return null;
  }
}

function samePrincipalClaims(current: Principal, claims: Record<string, unknown>): boolean {
  const allowed = new Set([
    "id",
    "username",
    "role",
    "kind",
    "allowedRepositoryIds",
    "boundHostId",
  ]);
  if (Object.keys(claims).some((key) => !allowed.has(key))) return false;
  if (
    claims.id !== current.id ||
    claims.username !== current.username ||
    claims.role !== current.role ||
    claims.kind !== current.kind ||
    claims.boundHostId !== current.boundHostId
  )
    return false;
  const actual = claims.allowedRepositoryIds;
  const expected = current.allowedRepositoryIds;
  if (actual === undefined || expected === undefined) return actual === expected;
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function isBrowserPrincipal(
  principal: Principal,
): principal is Principal & { kind: "admin" | "user" } {
  return principal.kind === "admin" || principal.kind === "user";
}

function browserPrincipal(
  principal: Principal & { kind: "admin" | "user" },
): ViewerTicketRecord["principal"] {
  return {
    id: principal.id,
    username: principal.username,
    role: principal.role,
    kind: principal.kind,
    ...(principal.allowedRepositoryIds
      ? { allowedRepositoryIds: principal.allowedRepositoryIds }
      : {}),
    ...(principal.boundHostId ? { boundHostId: principal.boundHostId } : {}),
  };
}

function hashViewerTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function isTicketHashCollision(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ConditionalCheckFailedException"
  );
}

export function cacheTtlFromEnv(value = process.env.HARNESS_AUTH_CACHE_TTL_MS): number {
  if (value === undefined || value === "") return DEFAULT_CACHE_TTL_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("HARNESS_AUTH_CACHE_TTL_MS must be a non-negative integer");
  }
  return parsed;
}

export function authModeFromEnv(value = process.env.HARNESS_AUTH_MODE): AuthMode {
  if (value === undefined || value === "" || value === "disabled") return "disabled";
  if (value === "required") return "required";
  throw new Error("HARNESS_AUTH_MODE must be disabled or required");
}
