"use client";

import { Button, dismissToast } from "@auto-harness/ui";

import {
  validateSlackForm,
  type SlackIntegration,
  type SlackFormValues,
} from "./slack-settings.ts";
import { SlackSettingsFields } from "./slack-settings-fields.tsx";
import { readSlackFormValues } from "./slack-delivery-settings-form.tsx";

export function SlackManualReplacementForm({
  config,
  error,
  pending,
  onSave,
  onError,
}: {
  config: SlackIntegration;
  error: string | null;
  pending: boolean;
  onSave: (form: HTMLFormElement, values: SlackFormValues) => void;
  onError: (message: string) => void;
}) {
  return (
    <form
      className="grid gap-4 rounded-md border border-border p-4"
      data-pw="form-slack-manual-replace"
      onSubmit={(event) => {
        event.preventDefault();
        dismissToast();
        const form = event.currentTarget;
        const values = readSlackFormValues(config, form);
        const validationError = validateSlackForm(values);
        if (validationError) {
          onError(validationError);
          return;
        }
        onSave(form, values);
      }}
    >
      <div>
        <h4 className="font-medium">Switch to manual credentials</h4>
        <p className="text-sm text-muted-foreground">
          Enter a bot token and optional signing secret to replace the OAuth installation. Secrets
          are write-only and never returned.
        </p>
      </div>
      <SlackSettingsFields
        config={config}
        error={error}
        credentialsOnly
        errorId="slack-manual-error"
      />
      {error ? (
        <p className="text-sm text-red-700" role="alert" data-pw="slack-manual-error">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} data-pw="slack-manual-submit">
        {pending ? "Saving…" : "Save manual configuration"}
      </Button>
    </form>
  );
}
