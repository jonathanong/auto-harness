import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@auto-harness/ui";
import type { Command, Provider, ProviderAccount } from "@auto-harness/shared";

import { AddProviderDialog } from "../../components/add-provider-dialog.tsx";
import { apiGet } from "../../lib/api.ts";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  let providers: Provider[] = [];
  let accounts: ProviderAccount[] = [];
  let commands: Command[] = [];
  let error: string | null = null;
  try {
    const [p, a, c] = await Promise.all([
      apiGet<{ items: Provider[] }>("/api/v1/providers"),
      apiGet<{ items: ProviderAccount[] }>("/api/v1/provider-accounts"),
      apiGet<{ items: Command[] }>("/api/v1/commands"),
    ]);
    providers = p.items ?? [];
    accounts = a.items ?? [];
    commands = c.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const commandById = new Map(commands.map((c) => [c.id, c]));

  return (
    <div className="space-y-6" data-pw="page-providers">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight" data-pw="providers-heading">
            Providers
          </h2>
          <p className="text-sm text-muted-foreground">
            AI CLI vendors (claude, codex, grok…). Each provider needs a default command to resolve
            accounts under it.
          </p>
        </div>
        <AddProviderDialog />
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>name</TableHead>
            <TableHead>default command</TableHead>
            <TableHead>accounts</TableHead>
            <TableHead>commands</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {providers.map((p) => {
            const defaultCommand = p.defaultCommandId ? commandById.get(p.defaultCommandId) : null;
            const accountCount = accounts.filter((a) => a.providerId === p.id).length;
            const commandCount = commands.filter((c) => c.providerId === p.id).length;
            return (
              <TableRow key={p.id} data-pw={`provider-row-${p.id}`}>
                <TableCell className="font-mono text-sm">
                  <Link
                    href={`/providers/${encodeURIComponent(p.id)}`}
                    className="hover:underline"
                    data-pw={`provider-link-${p.id}`}
                  >
                    {p.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{defaultCommand?.name ?? "—"}</TableCell>
                <TableCell>{accountCount}</TableCell>
                <TableCell>{commandCount}</TableCell>
              </TableRow>
            );
          })}
          {providers.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                No providers registered yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
