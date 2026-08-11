import { Input, Label } from "@auto-harness/ui";

import {
  initialSlackFormValues,
  notificationFields,
  type PublicSlackIntegration,
} from "./slack-settings.ts";

export function SlackSettingsFields({
  config,
  error,
}: {
  config?: PublicSlackIntegration;
  error: string | null;
}) {
  const values = initialSlackFormValues(config);
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor="slack-bot-token">Bot token</Label>
        <Input
          id="slack-bot-token"
          name="botToken"
          type="password"
          autoComplete="new-password"
          required
          aria-describedby={error ? "slack-secret-help slack-error" : "slack-secret-help"}
          aria-invalid={Boolean(error)}
          data-pw="slack-bot-token"
        />
      </div>
      <p id="slack-secret-help" className="text-xs text-muted-foreground">
        Starts with <code>xoxb-</code>. This field is write-only and is cleared after saving.
      </p>
      <div className="space-y-1">
        <Label htmlFor="slack-signing-secret">Signing secret (optional)</Label>
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
      <div className="space-y-1">
        <Label htmlFor="slack-default-channel">Default channel</Label>
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
        <span>Integration enabled</span>
      </label>
      <fieldset className="grid gap-2 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium">Notification toggles</legend>
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
  );
}
