import { createHash, randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";

import type { AuthAccountRecord } from "./db/plane-storage.ts";
import type { Principal, Role } from "./auth-types.ts";

export type User = Principal & { passwordHash: string };
export type ServiceAccount = Principal & { keyHash: string; name: string };
export type AuthStorage = {
  listAuthAccounts(): Promise<AuthAccountRecord[]>;
  getAuthAccountByUsername?(username: string): Promise<AuthAccountRecord | null>;
  putAuthAccount(record: AuthAccountRecord): Promise<void>;
  deleteAuthAccount(id: string): Promise<void>;
};

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function publicPrincipal(value: User | ServiceAccount): Principal {
  const { id, username, role, kind, allowedRepositoryIds, boundHostId } = value;
  return {
    id,
    username,
    role,
    kind,
    ...(allowedRepositoryIds ? { allowedRepositoryIds } : {}),
    ...(boundHostId ? { boundHostId } : {}),
  };
}

export async function hydrateAccounts(
  storage: AuthStorage | undefined,
  users: Map<string, User>,
  accounts: Map<string, ServiceAccount>,
): Promise<void> {
  if (!storage) return;
  const hydratedUsers = new Map<string, User>();
  const hydratedAccounts = new Map<string, ServiceAccount>();
  for (const record of await storage.listAuthAccounts()) {
    if (record.kind === "user" && record.passwordHash)
      hydratedUsers.set(record.username, toUser(record));
    else if (record.kind === "service-account" && record.apiKeyHash)
      hydratedAccounts.set(record.id, toServiceAccount(record));
  }
  users.clear();
  accounts.clear();
  for (const [key, value] of hydratedUsers) users.set(key, value);
  for (const [key, value] of hydratedAccounts) accounts.set(key, value);
}

export async function createUser(
  input: { username: string; password: string; role: Role },
  users: Map<string, User>,
  admins: User[],
  storage?: AuthStorage,
): Promise<Principal> {
  validateCredential(input.username, "username");
  validateCredential(input.password, "password");
  if (users.has(input.username) || admins.some((admin) => admin.username === input.username))
    throw new Error("username already exists");
  const user: User = {
    id: `user:${input.username}`,
    username: input.username,
    role: input.role,
    kind: "user",
    passwordHash: await bcrypt.hash(input.password, 12),
  };
  if (storage) await storage.putAuthAccount(toRecord(user));
  users.set(user.username, user);
  return publicPrincipal(user);
}

/** Keep account identifiers and bcrypt inputs bounded at every account boundary. */
export function validateCredential(value: string, label: string): void {
  if (!value || value.length > 256 || [...value].some(isControlCharacter)) {
    throw new Error(`${label} is invalid`);
  }
}

function isControlCharacter(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return code < 32 || code === 127;
}

export async function createServiceAccount(
  input: { name: string; role: Role; allowedRepositoryIds?: string[]; boundHostId?: string },
  accounts: Map<string, ServiceAccount>,
  storage?: AuthStorage,
): Promise<{ account: Principal & { name: string }; apiKey: string }> {
  validateCredential(input.name, "name");
  const apiKey = `hns_${randomBytes(36).toString("base64url")}`;
  const account: ServiceAccount = {
    id: `service:${randomBytes(12).toString("hex")}`,
    username: input.name,
    name: input.name,
    role: input.role,
    kind: "service-account",
    keyHash: hashApiKey(apiKey),
    ...(input.allowedRepositoryIds?.length
      ? { allowedRepositoryIds: [...input.allowedRepositoryIds] }
      : {}),
    ...(input.boundHostId ? { boundHostId: input.boundHostId } : {}),
  };
  if (storage) await storage.putAuthAccount(toRecord(account));
  accounts.set(account.id, account);
  return { account: { ...publicPrincipal(account), name: account.name }, apiKey };
}

function toRecord(value: User | ServiceAccount, createdAt?: string): AuthAccountRecord {
  const at = new Date().toISOString();
  return {
    id: value.id,
    username: value.username,
    ...(value.kind === "service-account"
      ? { name: value.name, apiKeyHash: value.keyHash }
      : { passwordHash: value.passwordHash }),
    kind: value.kind,
    role: value.role,
    ...(value.allowedRepositoryIds ? { allowedRepositoryIds: value.allowedRepositoryIds } : {}),
    ...(value.boundHostId ? { boundHostId: value.boundHostId } : {}),
    createdAt: createdAt ?? at,
    updatedAt: at,
  };
}

export function toUser(record: AuthAccountRecord): User {
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    kind: "user",
    passwordHash: record.passwordHash!,
    ...(record.allowedRepositoryIds ? { allowedRepositoryIds: record.allowedRepositoryIds } : {}),
    ...(record.boundHostId ? { boundHostId: record.boundHostId } : {}),
  };
}

function toServiceAccount(record: AuthAccountRecord): ServiceAccount {
  return {
    id: record.id,
    username: record.username,
    name: record.name ?? record.username,
    role: record.role,
    kind: "service-account",
    keyHash: record.apiKeyHash!,
    ...(record.allowedRepositoryIds ? { allowedRepositoryIds: record.allowedRepositoryIds } : {}),
    ...(record.boundHostId ? { boundHostId: record.boundHostId } : {}),
  };
}
