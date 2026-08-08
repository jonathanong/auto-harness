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
import type { Command, Provider, ProviderAccount } from "@auto-harness/shared";

import { AddProviderAccountForm } from "../../../components/add-provider-account-form.tsx";
import { CommandCreateForm } from "../../../components/command-create-form.tsx";
import { DeleteProviderButton } from "../../../components/delete-provider-button.tsx";
import { EditProviderForm } from "../../../components/edit-provider-form.tsx";
import { ProviderDefaultCommandForm } from "../../../components/provider-default-command-form.tsx";
import { RemoveProviderAccountButton } from "../../../components/remove-provider-account-button.tsx";
import { apiGet } from "../../../lib/api.ts";

export const dynamic = "force-dynamic";

type AgentHost = { hostId: string; providerAccounts?: Array<{ providerAccountId: string }> };

export default async function ProviderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ providerId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { providerId } = await params;
  const { tab } = await searchParams;

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

  let accounts: ProviderAccount[] = [];
  let commands: Command[] = [];
  let agentHosts: AgentHost[] = [];
  try {
    const [a, c, h] = await Promise.all([
      apiGet<{ items: ProviderAccount[] }>("/api/v1/provider-accounts"),
      apiGet<{ items: Command[] }>("/api/v1/commands"),
      apiGet<{ items: AgentHost[] }>("/api/v1/agent-hosts"),
    ]);
    accounts = (a.items ?? []).filter((x) => x.providerId === providerId);
    commands = (c.items ?? []).filter((x) => x.providerId === providerId);
    agentHosts = h.items ?? [];
  } catch {
    /* ignore — tabs stay empty */
  }

  const attachedHostCount = (accountId: string): number =>
    agentHosts.filter((h) =>
      (h.providerAccounts ?? []).some((pa) => pa.providerAccountId === accountId),
    ).length;

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
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>label</TableHead>
                      <TableHead>attached hosts</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((a) => (
                      <TableRow key={a.id} data-pw={`provider-account-row-${a.id}`}>
                        <TableCell className="font-mono text-sm">{a.label}</TableCell>
                        <TableCell>{attachedHostCount(a.id)}</TableCell>
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
                        <TableCell colSpan={3} className="text-muted-foreground">
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
                <CommandCreateForm fixedProviderId={providerId} />
              </div>
            ),
          },
          {
            key: "settings",
            label: "Settings",
            content: (
              <div className="space-y-4" data-pw="provider-settings">
                <p className="font-mono text-xs text-muted-foreground">id: {provider.id}</p>
                <div className="flex flex-wrap gap-2">
                  <EditProviderForm provider={provider} />
                  <DeleteProviderButton
                    providerId={providerId}
                    accountCount={accounts.length}
                    commandCount={commands.length}
                  />
                </div>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
