import type { Command, ProviderAccount, ProviderAccountLeaseState } from "@auto-harness/shared";

import { apiGet } from "../../../lib/api.ts";

type AgentHost = { hostId: string; providerAccounts?: Array<{ providerAccountId: string }> };

export async function loadProviderDetailData(providerId: string, includeLeases: boolean) {
  let accounts: ProviderAccount[] = [];
  let commands: Command[] = [];
  let agentHosts: AgentHost[] = [];
  const leasesByAccount = new Map<string, ProviderAccountLeaseState[] | null>();
  try {
    const [accountResponse, commandResponse, hostResponse] = await Promise.all([
      apiGet<{ items: ProviderAccount[] }>("/api/v1/provider-accounts"),
      apiGet<{ items: Command[] }>("/api/v1/commands"),
      apiGet<{ items: AgentHost[] }>("/api/v1/host-inventories"),
    ]);
    accounts = (accountResponse.items ?? []).filter((account) => account.providerId === providerId);
    commands = (commandResponse.items ?? []).filter((command) => command.providerId === providerId);
    agentHosts = hostResponse.items ?? [];
  } catch {
    /* Empty tabs communicate an unavailable catalog without hiding the provider. */
  }
  if (includeLeases) {
    const leaseReads = await Promise.allSettled(
      accounts.map((account) =>
        apiGet<{ items: ProviderAccountLeaseState[] }>(
          `/api/v1/provider-accounts/${encodeURIComponent(account.id)}/leases`,
        ),
      ),
    );
    for (const [index, account] of accounts.entries()) {
      const result = leaseReads[index]!;
      leasesByAccount.set(account.id, result.status === "fulfilled" ? result.value.items : null);
    }
  }
  return { accounts, commands, agentHosts, leasesByAccount };
}
