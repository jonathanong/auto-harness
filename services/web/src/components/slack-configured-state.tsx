import type { SlackIntegration } from "./slack-settings.ts";

function slackDeliveryStateLabel(config?: SlackIntegration): string {
  if (!config) return "Not configured";
  if (!config.enabled) return "Disabled";
  if (config.deliveryAvailable) return "Available";
  return "Configured but delivery unavailable";
}

export function SlackConfiguredState({ config }: { config?: SlackIntegration }) {
  const installationMethod = config?.installationMethod === "oauth" ? "OAuth" : "Manual token";
  const scopes = config?.grantedScopes?.filter(Boolean).join(", ");
  return (
    <div className="rounded-md border border-border p-3 text-sm" data-pw="slack-configured-state">
      <p className="font-medium">Configured state</p>
      <dl className="mt-2 grid gap-1 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Connection</dt>
          <dd data-pw="slack-installation-method-state">{installationMethod}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Bot token</dt>
          <dd data-pw="slack-bot-token-state">
            {config?.botTokenConfigured ? "Configured" : "Not configured"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Signing secret</dt>
          <dd data-pw="slack-signing-secret-state">
            {config?.installationMethod === "oauth"
              ? "Managed by app configuration"
              : config?.signingSecretConfigured
                ? "Configured"
                : "Not configured"}
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
        <div>
          <dt className="text-muted-foreground">Delivery</dt>
          <dd data-pw="slack-delivery-state">{slackDeliveryStateLabel(config)}</dd>
        </div>
        {config?.workspaceName || config?.workspaceId ? (
          <div>
            <dt className="text-muted-foreground">Workspace</dt>
            <dd data-pw="slack-workspace-state">
              {config.workspaceName ?? config.workspaceId}
              {config.workspaceName && config.workspaceId ? ` (${config.workspaceId})` : null}
            </dd>
          </div>
        ) : null}
        {config?.appId ? (
          <div>
            <dt className="text-muted-foreground">App</dt>
            <dd data-pw="slack-app-state">{config.appId}</dd>
          </div>
        ) : null}
        {config ? (
          <div>
            <dt className="text-muted-foreground">Inbound events</dt>
            <dd data-pw="slack-inbound-state">
              {config.inboundAvailable ? "Available" : "Unavailable"}
            </dd>
          </div>
        ) : null}
      </dl>
      {scopes ? (
        <p className="mt-2 text-xs text-muted-foreground" data-pw="slack-scopes-state">
          Granted scopes: {scopes}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">
        Secret values are never returned, prefilled, logged, or cached. Enter them again for every
        create or full replacement.
      </p>
    </div>
  );
}
