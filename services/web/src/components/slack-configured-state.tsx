"use client";

import type { PublicSlackIntegration } from "./slack-settings.ts";

export function SlackConfiguredState({ config }: { config?: PublicSlackIntegration }) {
  return (
    <div className="rounded-md border border-border p-3 text-sm" data-pw="slack-configured-state">
      <p className="font-medium">Configured state</p>
      <dl className="mt-2 grid gap-1 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Bot token</dt>
          <dd data-pw="slack-bot-token-state">
            {config?.botTokenConfigured ? "Configured" : "Not configured"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Signing secret</dt>
          <dd data-pw="slack-signing-secret-state">
            {config?.signingSecretConfigured ? "Configured" : "Not configured"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Default channel</dt>
          <dd data-pw="slack-default-channel-state">{config?.defaultChannel ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Enabled</dt>
          <dd data-pw="slack-enabled-state">{config?.enabled ? "Yes" : "No"}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        Secret values are never returned, prefilled, logged, or cached. Enter them again for every
        create or full replacement.
      </p>
    </div>
  );
}
