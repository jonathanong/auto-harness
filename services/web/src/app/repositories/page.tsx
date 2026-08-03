import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@auto-harness/ui";

import { AttachLocalRepoForm } from "../../components/attach-local-repo-form.tsx";
import { RepoCreateForm } from "../../components/repo-create-form.tsx";
import { apiGet } from "../../lib/api.ts";

export const dynamic = "force-dynamic";

type Repo = { id: string; name: string; url: string; defaultBranch?: string };
type Agent = { agentId: string };

export default async function RepositoriesPage() {
  let items: Repo[] = [];
  let agentIds: string[] = [];
  let error: string | null = null;
  try {
    const [repos, agents] = await Promise.all([
      apiGet<{ items: Repo[] }>("/api/v1/repositories"),
      apiGet<{ items: Agent[] }>("/api/v1/agents"),
    ]);
    items = repos.items ?? [];
    agentIds = (agents.items ?? []).map((a) => a.agentId);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Repositories</h2>
        <p className="text-sm text-muted-foreground">
          Add a local repo from this control pane (pick an online agent + absolute path on that
          host), or from the agent pane at :7423/config. Both register the catalog entry and host
          inventory.
        </p>
      </div>
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
                No repositories yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      <div>
        <h3 className="mb-2 text-lg font-medium">Register local repo on an agent</h3>
        <AttachLocalRepoForm agentIds={agentIds} />
      </div>

      <div className="border-t border-border pt-6">
        <h3 className="mb-2 text-lg font-medium">Catalog only (no agent path)</h3>
        <p className="mb-2 text-sm text-muted-foreground">
          Creates a control-plane repository record without attaching host inventory. Prefer the
          form above for local agents.
        </p>
        <RepoCreateForm />
      </div>
    </div>
  );
}
