"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, WithTooltip } from "@auto-harness/ui";

import {
  buildSlackConfigBody,
  notificationFields,
  responseMessage,
  validateSlackForm,
  type PublicSlackIntegration,
  type SlackFormValues,
  type SlackNotifications,
} from "./slack-settings.ts";
import { SlackConfiguredState } from "./slack-configured-state.tsx";
import { SlackDeleteSection } from "./slack-delete-section.tsx";
import { SlackSettingsFields } from "./slack-settings-fields.tsx";
import { apiFetch } from "../lib/client-api.ts";

export function SlackSettingsForm({ initial }: { initial?: PublicSlackIntegration }) {
  const router = useRouter();
  const [config, setConfig] = useState<PublicSlackIntegration | undefined>(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const mounted = useRef(true);
  const configured = Boolean(config);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function save(form: HTMLFormElement, values: SlackFormValues): Promise<void> {
    try {
      const response = await apiFetch("/api/v1/integrations/slack", {
        method: configured ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSlackConfigBody(values)),
        cache: "no-store",
      });
      if (!response.ok) {
        const message = await responseMessage(response);
        if (mounted.current) setError(message);
        return;
      }
      const next = (await response.json()) as PublicSlackIntegration;
      if (!mounted.current) return;
      // Reset first so browser password managers and the DOM cannot retain plaintext secrets.
      form.reset();
      setConfig(next);
      setSuccess("Slack configuration saved. Configuration alone does not send messages.");
      router.refresh();
    } catch {
      if (mounted.current) setError("Unable to save Slack configuration. Try again.");
    }
  }

  return (
    <Card data-pw="slack-settings-card">
      <CardHeader>
        <CardTitle>Slack configuration</CardTitle>
        <p className="text-sm text-muted-foreground">
          Store the workspace configuration used by future notification delivery.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
          role="note"
          data-pw="slack-delivery-warning"
        >
          Configuration alone does not send Slack messages. OAuth, delivery, inbound verification,
          and session threads are separate capabilities and are not enabled here.
        </div>

        <SlackConfiguredState config={config} />
        <form
          key={configured ? `replace-${config?.version ?? 0}` : "create"}
          className="grid gap-4"
          data-pw={configured ? "form-slack-replace" : "form-slack-create"}
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setSuccess(null);
            const form = event.currentTarget;
            const formData = new FormData(form);
            const values: SlackFormValues = {
              botToken: String(formData.get("botToken") ?? ""),
              signingSecret: String(formData.get("signingSecret") ?? ""),
              defaultChannel: String(formData.get("defaultChannel") ?? ""),
              enabled: formData.get("enabled") === "on",
              notifications: Object.fromEntries(
                notificationFields.map(({ key }) => [key, formData.get(String(key)) === "on"]),
              ) as unknown as SlackNotifications,
            };
            const validationError = validateSlackForm(values);
            if (validationError) {
              setError(validationError);
              return;
            }
            start(() => save(form, values));
          }}
        >
          <h4 className="font-medium">
            {configured ? "Replace configuration" : "Create configuration"}
          </h4>
          {configured ? (
            <p className="text-sm text-muted-foreground" data-pw="slack-replace-help">
              Replacement is complete: enter the bot token again. Existing secrets cannot be
              revealed or preserved by the UI.
            </p>
          ) : null}
          <SlackSettingsFields config={config} error={error} />
          {error ? (
            <p
              id="slack-error"
              className="text-sm text-red-700"
              role="alert"
              aria-live="assertive"
              data-pw="slack-error"
            >
              {error}
            </p>
          ) : null}
          {success ? (
            <p
              className="text-sm text-emerald-700"
              role="status"
              aria-live="polite"
              data-pw="slack-ok"
            >
              {success}
            </p>
          ) : null}
          <WithTooltip
            tip={
              configured
                ? "Replace every Slack setting, including the bot token"
                : "Save the Slack configuration securely"
            }
          >
            <Button type="submit" disabled={pending} data-pw="slack-submit">
              {pending ? "Saving…" : configured ? "Replace configuration" : "Create configuration"}
            </Button>
          </WithTooltip>
        </form>

        {configured ? (
          <SlackDeleteSection
            pending={pending}
            onConfirm={async () => {
              setError(null);
              setSuccess(null);
              try {
                const response = await apiFetch("/api/v1/integrations/slack", {
                  method: "DELETE",
                  cache: "no-store",
                });
                if (!response.ok) {
                  const message = await responseMessage(response);
                  if (mounted.current) setError(message);
                  return;
                }
                if (!mounted.current) return;
                setConfig(undefined);
                setSuccess("Slack configuration deleted.");
                router.refresh();
              } catch {
                if (mounted.current) setError("Unable to delete Slack configuration. Try again.");
              }
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
