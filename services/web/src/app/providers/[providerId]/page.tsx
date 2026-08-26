import Link from "next/link";
import {
  DetailHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
} from "@auto-harness/ui";
import type { Provider } from "@auto-harness/shared";

import { AddCommandDialog } from "../../../components/add-command-dialog.tsx";
import { AddProviderAccountForm } from "../../../components/add-provider-account-form.tsx";
import { ProviderSettingsPanel } from "../../../components/provider-settings-panel.tsx";
import { ProviderAccountUnattachedWarning } from "../../../components/provider-account-unattached-warning.tsx";
import { ProviderDefaultCommandForm } from "../../../components/provider-default-command-form.tsx";
import { RemoveProviderAccountButton } from "../../../components/remove-provider-account-button.tsx";
import { ProviderAccountCooldownForm } from "../../../components/provider-account-cooldown-form.tsx";
import { ProviderAccountConcurrencyForm } from "../../../components/provider-account-concurrency-form.tsx";
import { ProviderAccountLeases } from "../../../components/provider-account-leases.tsx";
import { apiGet } from "../../../lib/api.ts";
import { can, loadPrincipal } from "../../../lib/principal.ts";
import { loadProviderDetailData } from "./provider-detail-data.ts";

export const dynamic = "force-dynamic";

export default async function ProviderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ providerId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { providerId } = await params;
  const { tab } = await searchParams;
  const canOperateProviderLeases = can(await loadPrincipal(), "providers:leases");

  let provider: Provider | undefined;
  try {
    provider = await apiGet<Provider>(`/api/v1/providers/${encodeURIComponent(providerId)}`);
  } catch {
    /* treated as not found below */
  }

  if (!provider) {
    return (
      <div className="space-y-4" data-pw="page-provider-detail-not-found">
        <Link href="/providers" className="text-sm text-muted-foreground hover:underline">
          ← Back to providers
        </Link>
        <p className="text-sm text-muted-foreground">
          No provider <code className="font-mono">{providerId}</code> registered with the control
          plane.
        </p>
      </div>
    );
  }

  const { accounts, commands, agentHosts, leasesByAccount } = await loadProviderDetailData(
    providerId,
    canOperateProviderLeases,
  );

  const attachedHostCount = (accountId: string): number =>
    agentHosts.filter((h) =>
      (h.providerAccounts ?? []).some((pa) => pa.providerAccountId === accountId),
    ).length;
  const unattachedLabels = accounts
    .filter((account) => attachedHostCount(account.id) === 0)
    .map((account) => account.label);

  return (
    <div className="space-y-6" data-pw="page-provider-detail">
      <DetailHeader
        breadcrumbs={[{ label: "Providers", href: "/providers" }, { label: provider.name }]}
        title={provider.name}
        titlePw="provider-detail-id"
      />
      <Tabs
        basePath={`/providers/${encodeURIComponent(providerId)}`}
        active={typeof tab === "string" ? tab : "accounts"}
        pw="provider-detail-tabs"
        tabs={[
          {
            key: "accounts",
            label: "Accounts",
            content: (
              <div className="space-y-4" data-pw="provider-accounts-tab">
                <ProviderAccountUnattachedWarning labels={unattachedLabels} />
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>label</TableHead>
                      <TableHead>attached hosts</TableHead>
                      <TableHead>health / cooldown</TableHead>
                      {canOperateProviderLeases ? <TableHead>held leases</TableHead> : null}
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((a) => (
                      <TableRow key={a.id} data-pw={`provider-account-row-${a.id}`}>
                        <TableCell className="font-mono text-sm">{a.label}</TableCell>
                        <TableCell>{attachedHostCount(a.id)}</TableCell>
                        <TableCell>
                          <ProviderAccountCooldownForm account={a} />
                          <ProviderAccountConcurrencyForm account={a} />
                        </TableCell>
                        {canOperateProviderLeases ? (
                          <TableCell>
                            <ProviderAccountLeases
                              accountId={a.id}
                              leases={leasesByAccount.get(a.id)!}
                            />
                          </TableCell>
                        ) : null}
                        <TableCell>
                          <RemoveProviderAccountButton
                            accountId={a.id}
                            attachedHostCount={attachedHostCount(a.id)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                    {accounts.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={canOperateProviderLeases ? 5 : 4}
                          className="text-muted-foreground"
                        >
                          No accounts of this provider yet.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
                <AddProviderAccountForm providerId={providerId} />
              </div>
            ),
          },
          {
            key: "commands",
            label: "Commands",
            content: (
              <div className="space-y-4" data-pw="provider-commands-tab">
                <ProviderDefaultCommandForm
                  providerId={providerId}
                  defaultCommandId={provider.defaultCommandId}
                  commands={commands}
                />
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>name</TableHead>
                      <TableHead>argv</TableHead>
                      <TableHead>default?</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {commands.map((c) => (
                      <TableRow key={c.id} data-pw={`provider-command-row-${c.id}`}>
                        <TableCell className="font-mono text-sm">{c.name}</TableCell>
                        <TableCell className="font-mono text-xs">{c.argv.join(" ")}</TableCell>
                        <TableCell>{c.id === provider.defaultCommandId ? "yes" : ""}</TableCell>
                        <TableCell>
                          <Link
                            href={`/commands/${encodeURIComponent(c.id)}`}
                            className="text-sm hover:underline"
                            data-pw={`provider-command-link-${c.id}`}
                          >
                            View
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                    {commands.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-muted-foreground">
                          No commands owned by this provider yet.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
                <AddCommandDialog fixedProviderId={providerId} />
              </div>
            ),
          },
          {
            key: "settings",
            label: "Settings",
            content: (
              <ProviderSettingsPanel
                accountCount={accounts.length}
                commandCount={commands.length}
                provider={provider}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
