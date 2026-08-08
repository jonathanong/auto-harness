import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@auto-harness/ui";
import {
  resolveProviderAccountCommandId,
  type Command,
  type HostInventory,
  type Provider,
  type ProviderAccount,
  type ProviderCatalog,
} from "@auto-harness/shared";

import { AttachProviderAccountToHostForm } from "./attach-provider-account-to-host-form.tsx";
import { HostProviderAccountCommandForm } from "./host-provider-account-command-form.tsx";
import { RemoveProviderAccountFromHostButton } from "./remove-provider-account-from-host-button.tsx";

export function HostProviderAccountsSection({
  agentId,
  inventory,
  accountsById,
  providersById,
  commandsById,
}: {
  agentId: string;
  inventory: HostInventory;
  accountsById: Record<string, ProviderAccount>;
  providersById: Record<string, Provider>;
  commandsById: Record<string, Command>;
}) {
  const catalog: ProviderCatalog = { providers: providersById, providerAccounts: accountsById };
  const attachedIds = new Set(inventory.providerAccounts.map((a) => a.providerAccountId));
  const availableAccounts = Object.values(accountsById)
    .filter((a) => !attachedIds.has(a.id))
    .map((a) => ({
      id: a.id,
      label: `${providersById[a.providerId]?.name ?? a.providerId} — ${a.label}`,
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="space-y-4" data-pw="host-provider-accounts-section">
      {inventory.providerAccounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No provider accounts attached yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>account</TableHead>
              <TableHead>effective command</TableHead>
              <TableHead>override</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {inventory.providerAccounts.map((hostAccount) => {
              const account = accountsById[hostAccount.providerAccountId];
              const provider = account ? providersById[account.providerId] : undefined;
              const label = account
                ? `${provider?.name ?? account.providerId} — ${account.label}`
                : hostAccount.providerAccountId;
              const effectiveCommandId = resolveProviderAccountCommandId(
                hostAccount.providerAccountId,
                undefined,
                undefined,
                inventory,
                catalog,
              );
              const providerCommands = provider
                ? Object.values(commandsById).filter((c) => c.providerId === provider.id)
                : [];
              return (
                <TableRow
                  key={hostAccount.providerAccountId}
                  data-pw={`host-provider-account-row-${hostAccount.providerAccountId}`}
                >
                  <TableCell className="font-mono text-sm">{label}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {effectiveCommandId
                      ? (commandsById[effectiveCommandId]?.name ?? effectiveCommandId)
                      : "— (no default command)"}
                  </TableCell>
                  <TableCell>
                    <HostProviderAccountCommandForm
                      agentId={agentId}
                      providerAccountId={hostAccount.providerAccountId}
                      currentCommandId={hostAccount.commandId}
                      providerCommands={providerCommands}
                    />
                  </TableCell>
                  <TableCell>
                    <RemoveProviderAccountFromHostButton
                      agentId={agentId}
                      providerAccountId={hostAccount.providerAccountId}
                      label={label}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <AttachProviderAccountToHostForm agentId={agentId} availableAccounts={availableAccounts} />
    </div>
  );
}
