"use client";

import { Button, WithTooltip, dismissToast } from "@auto-harness/ui";

import {
  initialSlackFormValues,
  notificationFields,
  validateSlackForm,
  validateSlackSettings,
  type SlackFormValues,
  type SlackIntegration,
  type SlackNotifications,
} from "./slack-settings.ts";
import { SlackSettingsFields } from "./slack-settings-fields.tsx";

export function SlackDeliverySettingsForm({
  config,
  credentials,
  pending,
  error,
  success,
  onSave,
  onError,
}: {
  config?: SlackIntegration;
  credentials: boolean;
  pending: boolean;
  error: string | null;
  success: string | null;
  onSave: (form: HTMLFormElement, values: SlackFormValues) => void;
  onError: (message: string) => void;
}) {
  const configured = Boolean(config);
  const method = configured ? "manual" : "create";
  return (
    <form
      key={`${method}-${config?.version ?? 0}`}
      className="grid gap-4"
      data-pw={
        configured
          ? credentials
            ? "form-slack-replace"
            : "form-slack-settings"
          : "form-slack-create"
      }
      onSubmit={(event) => {
        event.preventDefault();
        dismissToast();
        const form = event.currentTarget;
        const values = readSlackFormValues(config, form);
        const validationError = credentials
          ? validateSlackForm(values)
          : validateSlackSettings(values);
        if (validationError) {
          onError(validationError);
          return;
        }
        onSave(form, values);
      }}
    >
      <h4 className="font-medium">
        {configured
          ? credentials
            ? "Manual token configuration"
            : "Delivery settings"
          : "Manual token configuration"}
      </h4>
      {configured && credentials ? (
        <p className="text-sm text-muted-foreground" data-pw="slack-replace-help">
          Replacement is complete: enter the bot token again. Existing secrets cannot be revealed or
          preserved by the UI.
        </p>
      ) : null}
      <SlackSettingsFields config={config} error={error} credentials={credentials} />
      {error ? (
        <p id="slack-error" className="text-sm text-red-700" role="alert" data-pw="slack-error">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="text-sm text-emerald-700" role="status" data-pw="slack-ok">
          {success}
        </p>
      ) : null}
      <WithTooltip
        tip={
          configured && !credentials
            ? "Save Slack delivery settings"
            : configured
              ? "Replace every Slack setting, including the bot token"
              : "Save the Slack configuration securely"
        }
      >
        <Button type="submit" disabled={pending} data-pw="slack-submit">
          {pending
            ? "Saving…"
            : configured && !credentials
              ? "Save delivery settings"
              : configured
                ? "Save manual configuration"
                : "Create manual configuration"}
        </Button>
      </WithTooltip>
    </form>
  );
}

export function readSlackFormValues(
  config: SlackIntegration | undefined,
  form: HTMLFormElement,
): SlackFormValues {
  const formData = new FormData(form);
  const current = initialSlackFormValues(config);
  const hasControl = (name: string) => form.elements.namedItem(name) !== null;
  const hasNotificationControls = notificationFields.some(({ key }) => hasControl(String(key)));
  return {
    ...current,
    botToken: String(formData.get("botToken") ?? ""),
    signingSecret: String(formData.get("signingSecret") ?? ""),
    ...(formData.has("defaultChannel")
      ? { defaultChannel: String(formData.get("defaultChannel")) }
      : {}),
    ...(hasControl("enabled") ? { enabled: formData.get("enabled") === "on" } : {}),
    ...(hasNotificationControls
      ? {
          notifications: Object.fromEntries(
            notificationFields.map(({ key }) => [key, formData.get(String(key)) === "on"]),
          ) as unknown as SlackNotifications,
        }
      : {}),
  };
}
