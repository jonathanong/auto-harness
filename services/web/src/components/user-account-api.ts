import { apiErrorMessage, type UserRole } from "@auto-harness/shared";

import { apiFetch, apiFetchAllPages } from "../lib/client-api.ts";
import type { RepositoryOption } from "./service-account-api.ts";

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
  | { kind: "ready"; accounts: UserAccount[]; repositories: RepositoryOption[] }
  | { kind: "forbidden" }
  | { kind: "unauthorized" };

export async function loadUserAccounts(): Promise<UserAccountData> {
  const response = await apiFetch("/api/v1/auth/users", { cache: "no-store" });
  if (response.status === 401) return { kind: "unauthorized" };
  if (response.status === 403) return { kind: "forbidden" };
  if (!response.ok) throw new Error(await apiErrorMessage(response));
  const repositories = await apiFetchAllPages<RepositoryOption>("/api/v1/repositories", {
    cache: "no-store",
  });
  if (repositories.response.status === 401) return { kind: "unauthorized" };
  if (!repositories.response.ok) throw new Error(await apiErrorMessage(repositories.response));
  const body = (await response.json()) as { items?: UserAccount[] };
  return {
    kind: "ready",
    accounts: body.items ?? [],
    repositories: repositories.items.toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    ),
  };
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
