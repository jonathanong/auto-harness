import Link from "next/link";
import { DetailHeader } from "@auto-harness/ui";
import type { Command, Provider } from "@auto-harness/shared";

import { DeleteCommandButton } from "../../../components/delete-command-button.tsx";
import { EditCommandForm } from "../../../components/edit-command-form.tsx";
import { apiGet } from "../../../lib/api.ts";

export const dynamic = "force-dynamic";

export default async function CommandDetailPage({
  params,
}: {
  params: Promise<{ commandId: string }>;
}) {
  const { commandId } = await params;

  let command: Command | undefined;
  try {
    command = await apiGet<Command>(`/api/v1/commands/${encodeURIComponent(commandId)}`);
  } catch {
    /* treated as not found below */
  }

  if (!command) {
    return (
      <div className="space-y-4" data-pw="page-command-detail-not-found">
        <Link href="/commands" className="text-sm text-muted-foreground hover:underline">
          ← Back to commands
        </Link>
        <p className="text-sm text-muted-foreground">
          No command <code className="font-mono">{commandId}</code> registered with the control
          plane.
        </p>
      </div>
    );
  }

  let providers: Provider[] = [];
  try {
    const data = await apiGet<{ items: Provider[] }>("/api/v1/providers");
    providers = data.items ?? [];
  } catch {
    /* ignore — provider select stays empty */
  }

  const owner = command.providerId
    ? providers.find((p) => p.id === command!.providerId)
    : undefined;
  const defaultFor = providers.find((p) => p.defaultCommandId === command!.id);

  return (
    <div className="space-y-6" data-pw="page-command-detail">
      <DetailHeader
        breadcrumbs={[{ label: "Commands", href: "/commands" }, { label: command.name }]}
        title={command.name}
        titlePw="command-detail-id"
      />
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase text-muted-foreground">Id</dt>
          <dd className="font-mono text-xs text-muted-foreground">{command.id}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">Provider</dt>
          <dd className="font-mono text-sm" data-pw="command-detail-provider">
            {owner ? owner.name : "— (standalone)"}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs uppercase text-muted-foreground">argv</dt>
          <dd className="break-all font-mono text-sm" data-pw="command-detail-argv">
            {command.argv.join(" ")}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">Append prompt</dt>
          <dd className="font-mono text-sm">{command.appendPrompt ? "yes" : "no"}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2">
        <EditCommandForm command={command} providers={providers} />
        <DeleteCommandButton commandId={command.id} defaultForProviderName={defaultFor?.name} />
      </div>
    </div>
  );
}
