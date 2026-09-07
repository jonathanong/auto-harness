import Link from "next/link";
import {
  CursorPagination,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";
import type { Command, Provider } from "@auto-harness/shared";

import { AddCommandDialog } from "../../components/add-command-dialog.tsx";
import { apiGet, apiGetAllPages } from "../../lib/api.ts";
import { can, loadPrincipal } from "../../lib/principal.ts";

export const dynamic = "force-dynamic";

export default async function CommandsPage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const raw = await searchParams;
  const cursor = typeof raw.cursor === "string" ? raw.cursor : null;
  const canWriteCatalog = can(await loadPrincipal(), "catalog:write");
  let commands: Command[] = [];
  let nextCursor: string | null = null;
  let providers: Provider[] = [];
  let error: string | null = null;
  const commandsPath = `/api/v1/commands?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  try {
    const [c, p] = await Promise.all([
      apiGet<{ items: Command[]; nextCursor?: string | null }>(commandsPath),
      apiGetAllPages<Provider>("/api/v1/providers?limit=100"),
    ]);
    commands = c.items ?? [];
    nextCursor = c.nextCursor ?? null;
    providers = p;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const providerById = new Map(providers.map((p) => [p.id, p]));

  return (
    <div className="space-y-6" data-pw="page-commands">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight" data-pw="commands-heading">
            Commands
          </h2>
          <p className="text-sm text-muted-foreground">
            Named argv invocations. Standalone commands (no provider) run ungated on any worktree;
            provider-owned commands are reached through that provider's accounts.
          </p>
        </div>
        {canWriteCatalog ? <AddCommandDialog providers={providers} /> : null}
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>name</TableHead>
            <TableHead>argv</TableHead>
            <TableHead>provider</TableHead>
            <TableHead>append prompt</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {commands.map((c) => (
            <TableRow key={c.id} data-pw={`command-row-${c.id}`}>
              <TableCell className="font-mono text-sm">
                <Link
                  href={`/commands/${encodeURIComponent(c.id)}`}
                  className="hover:underline"
                  data-pw={`command-link-${c.id}`}
                >
                  {c.name}
                </Link>
              </TableCell>
              <TableCell className="font-mono text-xs">{c.argv.join(" ")}</TableCell>
              <TableCell className="text-sm">
                {c.providerId ? (providerById.get(c.providerId)?.name ?? c.providerId) : "—"}
              </TableCell>
              <TableCell>{c.appendPrompt ? "yes" : "no"}</TableCell>
            </TableRow>
          ))}
          {commands.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                No commands registered yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      <CursorPagination
        nextHref={nextCursor ? `/commands?cursor=${encodeURIComponent(nextCursor)}` : null}
      />
    </div>
  );
}
