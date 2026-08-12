import { CreateSessionForm } from "../../../components/create-session-form.tsx";
import { apiGet } from "../../../lib/api.ts";
import type { SessionTarget } from "../../../session-target.ts";

export const dynamic = "force-dynamic";

export default async function NewSessionPage() {
  let targets: SessionTarget[] = [];
  let availableLabels: string[] = [];
  const errors: string[] = [];
  const [targetResult, worktreeResult] = await Promise.allSettled([
    apiGet<{ items: SessionTarget[] }>("/api/v1/session-targets"),
    apiGet<{ items: Array<{ online?: boolean; labels?: string[] }> }>("/api/v1/worktrees"),
  ]);
  if (targetResult.status === "fulfilled") targets = targetResult.value.items ?? [];
  else errors.push(`targets: ${String(targetResult.reason)}`);
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

  return (
    <div className="mx-auto max-w-lg space-y-4" data-pw="page-session-new">
      <h2 className="text-2xl font-semibold tracking-tight" data-pw="session-new-heading">
        New session
      </h2>
      <p className="text-sm text-muted-foreground">
        Choose a provider pool or named command, with optional ordered fallbacks. Free-form shell is
        rejected.
      </p>
      {errors.length > 0 ? (
        <p className="text-sm text-red-700">Could not load session options: {errors.join("; ")}</p>
      ) : null}
      <CreateSessionForm targets={targets} availableLabels={availableLabels} />
    </div>
  );
}
