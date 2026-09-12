import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@auto-harness/ui";
import {
  thrownMessage,
  type Command,
  type Provider,
  type ProviderAccount,
} from "@auto-harness/shared";

import { AddProviderDialog } from "../../components/add-provider-dialog.tsx";
import { apiGetAllPages } from "../../lib/api.ts";
import { can, loadPrincipal } from "../../lib/principal.ts";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  const canWriteCatalog = can(await loadPrincipal(), "catalog:write");
  let providers: Provider[] = [];
  let accounts: ProviderAccount[] = [];
  let commands: Command[] = [];
  let error: string | null = null;
  try {
    const [p, a, c] = await Promise.all([
      apiGetAllPages<Provider>("/api/v1/providers?limit=100"),
      apiGetAllPages<ProviderAccount>("/api/v1/provider-accounts?limit=100"),
      apiGetAllPages<Command>("/api/v1/commands?limit=100"),
    ]);
    providers = p;
    accounts = a;
    commands = c;
  } catch (e) {
    error = thrownMessage(e);
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
        {canWriteCatalog ? <AddProviderDialog /> : null}
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
            const pausedCount = accounts.filter(
              (a) =>
                a.providerId === p.id &&
                Boolean(
                  (a as ProviderAccount & { usageLimitedUntil?: string | null }).usageLimitedUntil,
                ) &&
                new Date(
                  (a as ProviderAccount & { usageLimitedUntil?: string | null }).usageLimitedUntil!,
                ).getTime() > Date.now(),
            ).length;
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
                <TableCell>
                  {accountCount}
                  {pausedCount ? (
                    <span className="ml-2 text-xs text-amber-700">({pausedCount} paused)</span>
                  ) : null}
                </TableCell>
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
