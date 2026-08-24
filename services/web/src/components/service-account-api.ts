import { apiErrorMessage } from "@auto-harness/shared";

import { apiFetch, apiFetchAllPages } from "../lib/client-api.ts";

import type { UserRole } from "@auto-harness/shared";

type ServiceAccountRole = UserRole;

export type ServiceAccount = {
  id: string;
  name: string;
  role: ServiceAccountRole;
  createdAt: string;
  allowedRepositoryIds?: string[];
  boundHostId?: string;
};

export type RepositoryOption = { id: string; name: string };

export type ServiceAccountInput = {
  name: string;
  role: ServiceAccountRole;
  allowedRepositoryIds?: string[];
  boundHostId?: string;
};

export type ServiceAccountSecret = {
  account: ServiceAccount;
  apiKey: string;
};

type ServiceAccountData =
  | {
      kind: "ready";
      accounts: ServiceAccount[];
      repositories: RepositoryOption[];
      hostIds: string[];
    }
  | { kind: "forbidden" }
  | { kind: "unauthorized" };

export async function loadServiceAccountData(): Promise<ServiceAccountData> {
  const accounts = await apiFetch("/api/v1/auth/service-accounts", { cache: "no-store" });
  if (accounts.status === 401) return { kind: "unauthorized" };
  if (accounts.status === 403) return { kind: "forbidden" };
  if (!accounts.ok) throw new Error(await apiErrorMessage(accounts));
  const repositories = await apiFetchAllPages<RepositoryOption>("/api/v1/repositories", {
    cache: "no-store",
  });
  if (repositories.response.status === 401) return { kind: "unauthorized" };
  if (!repositories.response.ok) throw new Error(await apiErrorMessage(repositories.response));
  const hosts = await apiFetch("/api/v1/hosts", { cache: "no-store" });
  if (hosts.status === 401) return { kind: "unauthorized" };
  if (!hosts.ok) throw new Error(await apiErrorMessage(hosts));
  const accountBody = (await accounts.json()) as { items?: ServiceAccount[] };
  const hostBody = (await hosts.json()) as { items?: Array<{ hostId?: string }> };
  return {
    kind: "ready",
    accounts: accountBody.items ?? [],
    repositories: repositories.items.toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    ),
    hostIds: (hostBody.items ?? []).flatMap((item) => {
      const hostId = item.hostId?.trim();
      return hostId ? [hostId] : [];
    }),
  };
}

export async function createServiceAccount(
  input: ServiceAccountInput,
): Promise<ServiceAccountSecret> {
  const response = await apiFetch("/api/v1/auth/service-accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await apiErrorMessage(response));
  const result = (await response.json()) as Partial<ServiceAccountSecret>;
  if (!result.account || typeof result.apiKey !== "string" || !result.apiKey.startsWith("hns_")) {
    throw new Error("service account response did not include a one-time API key");
  }
  return result as ServiceAccountSecret;
}

export async function deleteServiceAccount(id: string): Promise<void> {
  const response = await apiFetch(`/api/v1/auth/service-accounts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await apiErrorMessage(response));
}
