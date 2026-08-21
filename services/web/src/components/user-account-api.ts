import { apiErrorMessage, type UserRole } from "@auto-harness/shared";

import { apiFetch } from "../lib/client-api.ts";

export type UserAccountRole = UserRole;

export type UserAccount = {
  id: string;
  username: string;
  role: UserAccountRole;
  kind: "user";
  allowedRepositoryIds?: string[];
};

export type UserAccountInput = {
  username: string;
  password: string;
  role: UserAccountRole;
  allowedRepositoryIds?: string[];
};

type UserAccountData =
  | { kind: "ready"; accounts: UserAccount[] }
  | { kind: "forbidden" }
  | { kind: "unauthorized" };

export async function loadUserAccounts(): Promise<UserAccountData> {
  const response = await apiFetch("/api/v1/auth/users", { cache: "no-store" });
  if (response.status === 401) return { kind: "unauthorized" };
  if (response.status === 403) return { kind: "forbidden" };
  if (!response.ok) throw new Error(await apiErrorMessage(response));
  const body = (await response.json()) as { items?: UserAccount[] };
  return { kind: "ready", accounts: body.items ?? [] };
}

export async function createUserAccount(input: UserAccountInput): Promise<UserAccount> {
  const response = await apiFetch("/api/v1/auth/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await apiErrorMessage(response));
  return (await response.json()) as UserAccount;
}

/** The current API route identifies durable users by username. */
export async function deleteUserAccount(username: string): Promise<void> {
  const response = await apiFetch(`/api/v1/auth/users/${encodeURIComponent(username)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await apiErrorMessage(response));
}
