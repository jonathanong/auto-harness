import {
  CreateSessionForm,
  type WorkspacePoolOption,
} from "../../../components/create-session-form.tsx";
import { apiGet, apiGetAllPages } from "../../../lib/api.ts";
import { can, isRepositoryScoped, loadPrincipal } from "../../../lib/principal.ts";
import type { SessionTarget } from "../../../session-target.ts";
import {
  cloneSourceId,
  includeDraftTargets,
  sessionCloneDraft,
  type SessionCloneDraft,
  type SessionCloneSource,
} from "../../../session-clone-draft.ts";

export const dynamic = "force-dynamic";

export default async function NewSessionPage({
  searchParams,
}: {
  searchParams: Promise<{ cloneFrom?: string | string[] }>;
}) {
  let targets: SessionTarget[] = [];
  let repositories: Array<{ id: string; name: string }> = [];
  let availableLabels: string[] = [];
  let workspacePools: WorkspacePoolOption[] = [];
  let draft: SessionCloneDraft | null = null;
  const errors: string[] = [];
  const principal = await loadPrincipal();
  const canWriteExecConfig = can(principal, "fleet:exec-config");
  const allowWorkspace = !isRepositoryScoped(principal);
  const query = await searchParams;
  const requestedCloneId = cloneSourceId(query.cloneFrom);
  if (query.cloneFrom !== undefined && !requestedCloneId) errors.push("clone source: invalid id");
  const [targetResult, repositoryResult, worktreeResult, workspacePoolResult, sourceResult] =
    await Promise.allSettled([
      apiGetAllPages<SessionTarget>("/api/v1/session-targets?limit=100"),
      apiGetAllPages<{ id: string; name: string }>("/api/v1/repositories?limit=100"),
      apiGetAllPages<{ online?: boolean; labels?: string[] }>("/api/v1/worktrees?limit=100"),
      allowWorkspace
        ? apiGet<{ items?: WorkspacePoolOption[] }>("/api/v1/workspace-pools")
        : Promise.resolve({ items: [] }),
      requestedCloneId
        ? apiGet<SessionCloneSource>(`/api/v1/sessions/${encodeURIComponent(requestedCloneId)}`)
        : Promise.resolve(null),
    ]);
  if (targetResult.status === "fulfilled") targets = targetResult.value;
  else errors.push(`targets: ${String(targetResult.reason)}`);
  if (repositoryResult.status === "fulfilled") {
    repositories = repositoryResult.value.toSorted((a, b) => a.name.localeCompare(b.name));
  } else errors.push(`repositories: ${String(repositoryResult.reason)}`);
  if (worktreeResult.status === "fulfilled") {
    availableLabels = [
      ...new Set(
        worktreeResult.value
          .filter((worktree) => worktree.online === true)
          .flatMap((worktree) => worktree.labels ?? [])
          .filter(Boolean),
      ),
    ].toSorted();
  } else errors.push(`labels: ${String(worktreeResult.reason)}`);
  if (workspacePoolResult.status === "fulfilled") {
    workspacePools = workspacePoolResult.value.items ?? [];
  } else {
    errors.push(`workspace pools: ${String(workspacePoolResult.reason)}`);
  }
  if (sourceResult.status === "fulfilled" && sourceResult.value) {
    draft = sessionCloneDraft(sourceResult.value);
    if (!draft) errors.push("clone source: session inputs are unavailable");
  } else if (sourceResult.status === "rejected") {
    errors.push("clone source: session could not be loaded");
  }
  targets = includeDraftTargets(targets, draft);
  if (draft) {
    availableLabels = [...new Set([...availableLabels, ...draft.requiredLabels])].toSorted();
    if (
      draft.repositoryId &&
      !repositories.some((repository) => repository.id === draft.repositoryId)
    ) {
      repositories = [{ id: draft.repositoryId, name: draft.repositoryId }, ...repositories];
    }
  }

  return (
    <div className="space-y-4" data-pw="page-session-new">
      <h2 className="text-2xl font-semibold tracking-tight" data-pw="session-new-heading">
        New session
      </h2>
      <p className="text-sm text-muted-foreground">
        Choose a provider pool or named command, with optional ordered fallbacks. Free-form shell is
        rejected.
      </p>
      {draft && requestedCloneId ? (
        <p className="rounded-md border bg-muted/40 p-3 text-sm" data-pw="session-clone-source">
          Editing replayable inputs from session <code>{requestedCloneId}</code>. Nothing is created
          until you submit this form.
        </p>
      ) : null}
      {errors.length > 0 ? (
        <p className="text-sm text-red-700">Could not load session options: {errors.join("; ")}</p>
      ) : null}
      <CreateSessionForm
        key={requestedCloneId ?? "fresh"}
        targets={targets}
        repositories={repositories}
        workspacePools={workspacePools}
        availableLabels={availableLabels}
        initialValues={draft}
        canWriteExecConfig={canWriteExecConfig}
        allowWorkspace={allowWorkspace}
      />
    </div>
  );
}
