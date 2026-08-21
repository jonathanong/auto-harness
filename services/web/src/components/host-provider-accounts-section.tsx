import {
  SectionError,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";
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
import { ProviderAccountCooldownForm } from "./provider-account-cooldown-form.tsx";

export function HostProviderAccountsSection({
  hostId,
  inventory,
  accountsById,
  providersById,
  commandsById,
  catalogError,
  canWrite = true,
}: {
  hostId: string;
  inventory: HostInventory;
  accountsById: Record<string, ProviderAccount>;
  providersById: Record<string, Provider>;
  commandsById: Record<string, Command>;
  catalogError?: string | null;
  canWrite?: boolean;
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
              <TableHead>health</TableHead>
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
                    {canWrite ? (
                      <HostProviderAccountCommandForm
                        hostId={hostId}
                        providerAccountId={hostAccount.providerAccountId}
                        currentCommandId={hostAccount.commandId}
                        providerCommands={providerCommands}
                      />
                    ) : hostAccount.commandId ? (
                      (commandsById[hostAccount.commandId]?.name ?? hostAccount.commandId)
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {canWrite && account ? (
                      <ProviderAccountCooldownForm
                        account={
                          account as typeof account & {
                            usageLimitCooldownSeconds?: number | null;
                            usageLimitedUntil?: string | null;
                            lastUsageLimitedAt?: string | null;
                          }
                        }
                      />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {canWrite ? (
                      <RemoveProviderAccountFromHostButton
                        hostId={hostId}
                        providerAccountId={hostAccount.providerAccountId}
                        label={label}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {canWrite ? (
        catalogError ? (
          <SectionError
            resource="provider accounts"
            message={catalogError}
            selector="host-provider-accounts-catalog"
          />
        ) : (
          <AttachProviderAccountToHostForm hostId={hostId} availableAccounts={availableAccounts} />
        )
      ) : null}
    </div>
  );
}
