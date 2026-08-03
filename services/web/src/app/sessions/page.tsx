import { Suspense } from "react";
import Link from "next/link";
import {
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";

import { SessionFilters } from "../../components/session-filters.tsx";
import { apiGet } from "../../lib/api.ts";
import { parseSessionListState } from "../../lib/url-state.ts";

export const dynamic = "force-dynamic";

type Session = {
  id: string;
  status: string;
  repositoryId?: string;
  prompt?: string;
  commandProfile?: string;
  source?: string;
  createdAt?: string;
};

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") {
      sp.set(k, v);
    }
  }
  const filters = parseSessionListState(sp);

  let items: Session[] = [];
  let error: string | null = null;
  try {
    const data = await apiGet<{ items: Session[] }>("/api/v1/sessions");
    items = data.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  let filtered = items;
  if (filters.status !== "all") {
    filtered = filtered.filter((s) => s.status === filters.status);
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    filtered = filtered.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        (s.prompt ?? "").toLowerCase().includes(q) ||
        (s.commandProfile ?? "").toLowerCase().includes(q),
    );
  }

  return (
    <div className="space-y-4" data-pw="page-sessions">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="sessions-heading">
          Sessions
        </h2>
        <Link
          href="/sessions/new"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          New session
        </Link>
      </div>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading filters…</p>}>
        <SessionFilters />
      </Suspense>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Profile</TableHead>
            <TableHead>Prompt</TableHead>
            <TableHead>Source</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-mono text-xs">{s.id}</TableCell>
              <TableCell>
                <StatusBadge status={s.status} />
              </TableCell>
              <TableCell>{s.commandProfile ?? "—"}</TableCell>
              <TableCell className="max-w-xs truncate">{s.prompt ?? "—"}</TableCell>
              <TableCell>{s.source ?? "—"}</TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                No sessions match filters.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
