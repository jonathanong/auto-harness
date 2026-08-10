/* eslint-disable max-lines -- authentication and account lifecycle share one security boundary. */
import { createHmac, timingSafeEqual } from "node:crypto";

import bcrypt from "bcryptjs";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal, Role } from "./auth-types.ts";
export type { Principal, Role } from "./auth-types.ts";
import {
  createServiceAccount,
  createUser,
  hashApiKey,
  hydrateAccounts,
  publicPrincipal,
  toUser,
  validateCredential,
  type AuthStorage,
  type ServiceAccount,
  type User,
} from "./auth-accounts.ts";

export type AuthMode = "disabled" | "required";
const COOKIE = "auto_harness_session";
const DAY_MS = 24 * 60 * 60 * 1000;
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
  return value === "admin" || value === "operator" || value === "read-only" ? value : null;
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

  constructor(options: { mode?: AuthMode; secret?: string; admins?: string } = {}) {
    this.mode = options.mode ?? authModeFromEnv();
    this.secret = options.secret ?? process.env.HARNESS_SESSION_SECRET ?? "";
    this.admins = parseAdmins(options.admins ?? process.env.HARNESS_ADMINS);
    if (this.mode === "required" && (this.secret.length < 32 || this.admins.length === 0)) {
      throw new Error(
        "HARNESS_AUTH_MODE=required needs HARNESS_SESSION_SECRET (at least 32 characters) and HARNESS_ADMINS",
      );
    }
  }

  async hydrate(storage: AuthStorage | undefined): Promise<void> {
    await hydrateAccounts(storage, this.users, this.serviceAccounts);
    this.storage = storage;
  }

  async createUser(
    input: { username: string; password: string; role: Role },
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
  ): Promise<{ account: Principal & { name: string }; apiKey: string }> {
    if (!input.name) throw new Error("name is required");
    return createServiceAccount(input, this.serviceAccounts, storage);
  }

  listServiceAccounts(): Array<Principal & { name: string }> {
    return [...this.serviceAccounts.values()].map((account) => ({
      ...publicPrincipal(account),
      name: account.name,
    }));
  }

  async deleteServiceAccount(id: string, storage?: AuthStorage): Promise<boolean> {
    if (!this.serviceAccounts.has(id)) return false;
    if (storage) await storage.deleteAuthAccount(id);
    return this.serviceAccounts.delete(id);
  }

  async authenticate(req: IncomingMessage): Promise<Principal | null> {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`));
    if (cookie) {
      const principal = this.verifySession(cookie.slice(COOKIE.length + 1));
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
    let user =
      this.admins.find((candidate) => candidate.username === username) ?? this.users.get(username);
    if (!user) {
      const record = await this.storage?.getAuthAccountByUsername?.(username);
      if (record?.kind === "user" && record.passwordHash) {
        user = toUser(record);
        this.users.set(user.username, user);
      }
    }
    const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    return user && valid ? publicPrincipal(user) : null;
  }

  authenticateApiKey(key: string): Principal | null {
    if (!key) return null;
    const hash = hashApiKey(key);
    for (const account of this.serviceAccounts.values()) {
      if (account.keyHash.length !== hash.length) continue;
      if (timingSafeEqual(Buffer.from(hash), Buffer.from(account.keyHash)))
        return publicPrincipal(account);
    }
    return null;
  }

  issueCookie(res: ServerResponse, principal: Principal): void {
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

  private verifySession(token: string): Principal | null {
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
    const value = parseB64urlJson<Principal & { exp?: unknown }>(payload);
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
    if (value.kind !== "admin" && value.kind !== "user" && value.kind !== "service-account")
      return null;
    const current = this.findCurrentPrincipal(value);
    const { exp: _exp, ...claims } = value;
    if (!current || !samePrincipalClaims(current, claims)) return null;
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
    const account = this.serviceAccounts.get(value.id);
    return account && account.username === value.username ? publicPrincipal(account) : null;
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

export function authModeFromEnv(value = process.env.HARNESS_AUTH_MODE): AuthMode {
  if (value === undefined || value === "" || value === "disabled") return "disabled";
  if (value === "required") return "required";
  throw new Error("HARNESS_AUTH_MODE must be disabled or required");
}
