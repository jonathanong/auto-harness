import { Input, Label } from "@auto-harness/ui";

import {
  initialSlackFormValues,
  notificationFields,
  type SlackIntegration,
} from "./slack-settings.ts";

export function SlackSettingsFields({
  config,
  error,
  credentials = true,
  credentialsOnly = false,
  errorId = "slack-error",
}: {
  config?: SlackIntegration;
  error: string | null;
  credentials?: boolean;
  credentialsOnly?: boolean;
  errorId?: string;
}) {
  const values = initialSlackFormValues(config);
  return (
    <>
      {credentials ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="slack-bot-token">Bot Token</Label>
            <Input
              id="slack-bot-token"
              name="botToken"
              type="password"
              autoComplete="new-password"
              required
              aria-describedby={error ? `slack-secret-help ${errorId}` : "slack-secret-help"}
              aria-invalid={Boolean(error)}
              data-pw="slack-bot-token"
            />
          </div>
          <p id="slack-secret-help" className="text-xs text-muted-foreground">
            Starts with <code>xoxb-</code>. This field is write-only and is cleared after saving.
          </p>
          <div className="space-y-1">
            <Label htmlFor="slack-signing-secret">Signing Secret (Optional)</Label>
            <Input
              id="slack-signing-secret"
              name="signingSecret"
              type="password"
              autoComplete="new-password"
              aria-describedby="slack-signing-secret-help"
              data-pw="slack-signing-secret"
            />
          </div>
          <p id="slack-signing-secret-help" className="text-xs text-muted-foreground">
            Leave blank to replace without a signing secret. It is never displayed.
          </p>
        </>
      ) : null}
      {!credentialsOnly ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="slack-default-channel">Default Channel</Label>
            <Input
              id="slack-default-channel"
              name="defaultChannel"
              required
              aria-invalid={Boolean(error)}
              defaultValue={values.defaultChannel}
              placeholder="#harness or C0123ABCDE"
              data-pw="slack-default-channel"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={values.enabled}
              data-pw="slack-enabled"
            />
            <span>Integration Enabled</span>
          </label>
          <fieldset className="grid gap-2 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium">Notification Toggles</legend>
            {notificationFields.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  name={key}
                  type="checkbox"
                  defaultChecked={values.notifications[key]}
                  data-pw={`slack-notification-${String(key)}`}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
        </>
      ) : null}
    </>
  );
}
