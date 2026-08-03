import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@auto-harness/ui";

import { RepoCreateForm } from "../../components/repo-create-form.tsx";
import { apiGet } from "../../lib/api.ts";

export const dynamic = "force-dynamic";

type Repo = { id: string; name: string; url: string; defaultBranch?: string };

export default async function RepositoriesPage() {
  let items: Repo[] = [];
  let error: string | null = null;
  try {
    const data = await apiGet<{ items: Repo[] }>("/api/v1/repositories");
    items = data.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold tracking-tight">Repositories</h2>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>URL / path</TableHead>
            <TableHead>Branch</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono text-xs">{r.id}</TableCell>
              <TableCell>{r.name}</TableCell>
              <TableCell className="max-w-xs truncate">{r.url}</TableCell>
              <TableCell>{r.defaultBranch ?? "main"}</TableCell>
            </TableRow>
          ))}
          {items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                No repositories configured.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      <div>
        <h3 className="mb-2 text-lg font-medium">Add repository</h3>
        <RepoCreateForm />
      </div>
    </div>
  );
}
