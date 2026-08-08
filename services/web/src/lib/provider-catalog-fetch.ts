import type { Command, Provider, ProviderAccount, ProviderCatalog } from "@auto-harness/shared";

import { apiGet } from "./api.ts";

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
      apiGet<{ items: Provider[] }>("/api/v1/providers"),
      apiGet<{ items: ProviderAccount[] }>("/api/v1/provider-accounts"),
      apiGet<{ items: Command[] }>("/api/v1/commands"),
    ]);
    providers = p.items ?? [];
    providerAccounts = a.items ?? [];
    commands = c.items ?? [];
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
