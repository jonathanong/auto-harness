import type { Command, ProviderAccount, ProviderAccountLeaseState } from "@auto-harness/shared";

import { apiGet, apiGetAllPages } from "../../../lib/api.ts";
import { rethrowControlFlowError } from "../../../lib/page-error.ts";

type AgentHost = { hostId: string; providerAccounts?: Array<{ providerAccountId: string }> };

export async function loadProviderDetailData(providerId: string, includeLeases: boolean) {
  let accounts: ProviderAccount[] = [];
  let commands: Command[] = [];
  let agentHosts: AgentHost[] = [];
  const leasesByAccount = new Map<string, ProviderAccountLeaseState[] | null>();
  try {
    const providerFilter = encodeURIComponent(providerId);
    const [accountItems, commandItems, hostResponse] = await Promise.all([
      apiGetAllPages<ProviderAccount>(
        `/api/v1/provider-accounts?providerId=${providerFilter}&limit=100`,
      ),
      apiGetAllPages<Command>(`/api/v1/commands?providerId=${providerFilter}&limit=100`),
      apiGet<{ items: AgentHost[] }>("/api/v1/host-inventories?limit=100"),
    ]);
    accounts = accountItems;
    commands = commandItems;
    agentHosts = hostResponse.items ?? [];
  } catch (e) {
    /* Empty tabs communicate an unavailable catalog without hiding the provider. */
    rethrowControlFlowError(e);
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
      if (result.status === "rejected") rethrowControlFlowError(result.reason);
      leasesByAccount.set(account.id, result.status === "fulfilled" ? result.value.items : null);
    }
  }
  return { accounts, commands, agentHosts, leasesByAccount };
}
