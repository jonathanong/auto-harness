import { apiErrorMessage } from "@auto-harness/shared";

import { apiFetch } from "./client-api.ts";
import { loadAllRepositoryPages, type RepositoryPage } from "./repository-catalog.ts";

export class RepositoryCatalogError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RepositoryCatalogError";
    this.status = status;
  }
}

/** Browser-side full catalog loader used by account scope editors. */
export function loadAllBrowserRepositories<T extends { id: string }>(): Promise<T[]> {
  return loadAllRepositoryPages<T>(async (path) => {
    const response = await apiFetch(path, { cache: "no-store" }, { redirectOnUnauthorized: false });
    if (!response.ok) {
      throw new RepositoryCatalogError(response.status, await apiErrorMessage(response));
    }
    return (await response.json()) as RepositoryPage<T>;
  });
}
