import { thrownMessage } from "@auto-harness/shared";
import { UserSessionsLive, type UserSession } from "../../components/user-sessions-live.tsx";
import { apiGet } from "../../lib/api.ts";

export const dynamic = "force-dynamic";

export default async function UserSessionsPage() {
  let items: UserSession[] = [];
  let error: string | null = null;
  try {
    const response = await apiGet<{ items: UserSession[] }>("/api/v1/user-sessions?limit=100");
    items = response.items ?? [];
  } catch (reason) {
    error = thrownMessage(reason);
  }

  return (
    <div className="space-y-4" data-pw="page-user-sessions">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="user-sessions-heading">
          User Sessions
        </h2>
        <p className="text-sm text-muted-foreground">
          Live browser connections tailing session logs. These are not host daemons and not CLI
          sessions.
        </p>
      </div>
      <UserSessionsLive initialItems={items} initialError={error} />
    </div>
  );
}
