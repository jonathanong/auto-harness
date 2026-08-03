import { CreateSessionForm } from "../../../components/create-session-form.tsx";
import { apiGet } from "../../../lib/api.ts";

export const dynamic = "force-dynamic";

export default async function NewSessionPage() {
  let profiles: string[] = [];
  let error: string | null = null;
  try {
    const data = await apiGet<{ items: string[] }>("/api/v1/command-profiles");
    profiles = data.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-lg space-y-4" data-pw="page-session-new">
      <h2 className="text-2xl font-semibold tracking-tight" data-pw="session-new-heading">
        New session
      </h2>
      <p className="text-sm text-muted-foreground">
        Command profiles only (D4) — free-form shell is rejected.
      </p>
      {error ? <p className="text-sm text-red-700">Could not load profiles: {error}</p> : null}
      <CreateSessionForm profiles={profiles} />
    </div>
  );
}
