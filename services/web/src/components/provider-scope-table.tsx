import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@auto-harness/ui";
import type {
  Command,
  Provider,
  ProviderAccount,
  ProviderAccountOverride,
  ProviderAccountScope,
  ProviderAccountScopeResolution,
} from "@auto-harness/shared";

import { ScopeProviderCommandForm } from "./scope-provider-command-form.tsx";
import { ScopeProviderEnabledForm } from "./scope-provider-enabled-form.tsx";

const SOURCE_LABEL: Record<string, string> = {
  worktree: "this worktree",
  repository: "repository",
  host: "host",
  "provider-default": "provider default",
  none: "—",
};

/**
 * Shared table for the repository and worktree detail pages' "Provider accounts" tab —
 * rows are the host-inherited accounts, showing each one's effective enabled/command state
 * and which scope it came from, with inline controls to override at *this* scope.
 */
export function ProviderScopeTable({
  agentId,
  scope,
  inheritedEnabledLabel,
  resolutions,
  overridesAtScope,
  accountsById,
  providersById,
  commandsById,
}: {
  agentId: string;
  scope: ProviderAccountScope;
  /** Label for the enabled picker's "(inherit from …)" option — e.g. "host" or "repository". */
  inheritedEnabledLabel: string;
  resolutions: ProviderAccountScopeResolution[];
  /** Raw providerAccountOverrides at this exact scope (not resolved) — pre-fills the forms. */
  overridesAtScope: Record<string, ProviderAccountOverride>;
  accountsById: Record<string, ProviderAccount>;
  providersById: Record<string, Provider>;
  commandsById: Record<string, Command>;
}) {
  if (resolutions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-pw="provider-scope-table-empty">
        No provider accounts attached to this host yet.
      </p>
    );
  }

  return (
    <Table data-pw="provider-scope-table">
      <TableHeader>
        <TableRow>
          <TableHead>account</TableHead>
          <TableHead>enabled</TableHead>
          <TableHead>inherited from</TableHead>
          <TableHead>effective command</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {resolutions.map((r) => {
          const account = accountsById[r.providerAccountId];
          const provider = account ? providersById[account.providerId] : undefined;
          const label = account
            ? `${provider?.name ?? account.providerId} — ${account.label}`
            : r.providerAccountId;
          const providerCommands = provider
            ? Object.values(commandsById).filter((c) => c.providerId === provider.id)
            : [];
          const override = overridesAtScope[r.providerAccountId];
          return (
            <TableRow
              key={r.providerAccountId}
              data-pw={`provider-scope-row-${r.providerAccountId}`}
            >
              <TableCell className="font-mono text-sm">{label}</TableCell>
              <TableCell>
                <ScopeProviderEnabledForm
                  agentId={agentId}
                  scope={scope}
                  providerAccountId={r.providerAccountId}
                  currentOverride={override?.enabled}
                  inheritedLabel={inheritedEnabledLabel}
                />
              </TableCell>
              <TableCell
                className="text-xs text-muted-foreground"
                data-pw={`provider-scope-inherited-${r.providerAccountId}`}
              >
                {SOURCE_LABEL[r.enabledSource] ?? r.enabledSource}
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <span
                    className="font-mono text-xs"
                    data-pw={`provider-scope-effective-command-${r.providerAccountId}`}
                  >
                    {r.commandId ? (commandsById[r.commandId]?.name ?? r.commandId) : "— (none)"}
                  </span>
                  <ScopeProviderCommandForm
                    agentId={agentId}
                    scope={scope}
                    providerAccountId={r.providerAccountId}
                    currentOverride={override?.commandId}
                    providerCommands={providerCommands}
                  />
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
