import { CreateSessionForm } from "../../../components/create-session-form.tsx";
import { apiGet } from "../../../lib/api.ts";
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
  let draft: SessionCloneDraft | null = null;
  const errors: string[] = [];
  const query = await searchParams;
  const requestedCloneId = cloneSourceId(query.cloneFrom);
  if (query.cloneFrom !== undefined && !requestedCloneId) errors.push("clone source: invalid id");
  const [targetResult, repositoryResult, worktreeResult, sourceResult] = await Promise.allSettled([
    apiGet<{ items: SessionTarget[] }>("/api/v1/session-targets"),
    apiGet<{ items: Array<{ id: string; name: string }> }>("/api/v1/repositories"),
    apiGet<{ items: Array<{ online?: boolean; labels?: string[] }> }>("/api/v1/worktrees"),
    requestedCloneId
      ? apiGet<SessionCloneSource>(`/api/v1/sessions/${encodeURIComponent(requestedCloneId)}`)
      : Promise.resolve(null),
  ]);
  if (targetResult.status === "fulfilled") targets = targetResult.value.items ?? [];
  else errors.push(`targets: ${String(targetResult.reason)}`);
  if (repositoryResult.status === "fulfilled") {
    repositories = (repositoryResult.value.items ?? []).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
  } else errors.push(`repositories: ${String(repositoryResult.reason)}`);
  if (worktreeResult.status === "fulfilled") {
    availableLabels = [
      ...new Set(
        (worktreeResult.value.items ?? [])
          .filter((worktree) => worktree.online === true)
          .flatMap((worktree) => worktree.labels ?? [])
          .filter(Boolean),
      ),
    ].toSorted();
  } else errors.push(`labels: ${String(worktreeResult.reason)}`);
  if (sourceResult.status === "fulfilled" && sourceResult.value) {
    draft = sessionCloneDraft(sourceResult.value);
    if (!draft) errors.push("clone source: session inputs are unavailable");
  } else if (sourceResult.status === "rejected") {
    errors.push("clone source: session could not be loaded");
  }
  targets = includeDraftTargets(targets, draft);
  if (draft) {
    availableLabels = [...new Set([...availableLabels, ...draft.requiredLabels])].toSorted();
    if (!repositories.some((repository) => repository.id === draft.repositoryId)) {
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
        availableLabels={availableLabels}
        initialValues={draft}
      />
    </div>
  );
}
