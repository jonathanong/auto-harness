import type { Command, Provider, ProviderAccount, ProviderCatalog } from "@auto-harness/shared";

import { apiGetAllPages } from "./api.ts";

type ProviderCatalogLookups = {
  providersById: Record<string, Provider>;
  providerAccountsById: Record<string, ProviderAccount>;
  commandsById: Record<string, Command>;
  catalog: ProviderCatalog;
};

/** Fetches the Provider/ProviderAccount/Command catalogs and builds id-keyed lookup maps. */
export async function fetchProviderCatalogLookups(): Promise<ProviderCatalogLookups> {
  let providers: Provider[] = [];
  let providerAccounts: ProviderAccount[] = [];
  let commands: Command[] = [];
  try {
    const [p, a, c] = await Promise.all([
      apiGetAllPages<Provider>("/api/v1/providers?limit=100"),
      apiGetAllPages<ProviderAccount>("/api/v1/provider-accounts?limit=100"),
      apiGetAllPages<Command>("/api/v1/commands?limit=100"),
    ]);
    providers = p;
    providerAccounts = a;
    commands = c;
  } catch {
    /* ignore — callers render empty provider-scope tables */
  }
  const providersById = Object.fromEntries(providers.map((p) => [p.id, p]));
  const providerAccountsById = Object.fromEntries(providerAccounts.map((a) => [a.id, a]));
  const commandsById = Object.fromEntries(commands.map((c) => [c.id, c]));
  return {
    providersById,
    providerAccountsById,
    commandsById,
    catalog: { providers: providersById, providerAccounts: providerAccountsById },
  };
}
