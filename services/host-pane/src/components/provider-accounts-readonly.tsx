import {
  resolveProviderAccountCommandId,
  type Command,
  type HostInventory,
  type Provider,
  type ProviderAccount,
  type ProviderCatalog,
} from "@auto-harness/shared";
import {
  ProviderAccountHealth,
  SectionError,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";

/**
 * Read-only mirror of this host's attached provider accounts — debugging visibility only.
 * Per the control-plane-does-everything invariant, attach/detach/override all happen on the
 * control plane; this app never mutates provider accounts.
 */
export function ProviderAccountsReadonly({
  inventory,
  accountsById,
  providersById,
  commandsById,
  catalogError,
}: {
  inventory: HostInventory;
  accountsById: Record<string, ProviderAccount>;
  providersById: Record<string, Provider>;
  commandsById: Record<string, Command>;
  catalogError?: string | null;
}) {
  const catalogErrorBanner = catalogError ? (
    <SectionError
      resource="the provider catalog"
      message={catalogError}
      selector="provider-accounts-readonly-catalog"
    />
  ) : null;

  if (inventory.providerAccounts.length === 0) {
    return (
      <>
        {catalogErrorBanner}
        <p className="text-sm text-muted-foreground" data-pw="provider-accounts-readonly-empty">
          No provider accounts attached to this host.
        </p>
      </>
    );
  }

  const catalog: ProviderCatalog = { providers: providersById, providerAccounts: accountsById };

  return (
    <div className="space-y-3">
      {catalogErrorBanner}
      <Table data-pw="provider-accounts-readonly">
        <TableHeader>
          <TableRow>
            <TableHead>account</TableHead>
            <TableHead>effective command</TableHead>
            <TableHead>health</TableHead>
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
            return (
              <TableRow
                key={hostAccount.providerAccountId}
                data-pw={`provider-accounts-readonly-row-${hostAccount.providerAccountId}`}
              >
                <TableCell className="font-mono text-sm">{label}</TableCell>
                <TableCell className="font-mono text-xs">
                  {effectiveCommandId
                    ? (commandsById[effectiveCommandId]?.name ?? effectiveCommandId)
                    : "— (no default command)"}
                </TableCell>
                <TableCell>
                  <ProviderAccountHealth
                    pw={`provider-accounts-readonly-health-${hostAccount.providerAccountId}`}
                    usageLimitedUntil={account?.usageLimitedUntil}
                    usageLimitCooldownSeconds={account?.usageLimitCooldownSeconds}
                    lastUsageLimitedAt={account?.lastUsageLimitedAt}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
