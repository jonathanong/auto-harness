"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Alert, Card, CardContent, CardHeader, CardTitle, showToast } from "@auto-harness/ui";

import {
  buildSlackConfigBody,
  buildSlackSettingsBody,
  responseMessage,
  slackInstallationMethod,
  slackDeliveryWarning,
  slackSaveSuccessMessage,
  type SlackIntegration,
  type SlackFormValues,
} from "./slack-settings.ts";
import { SlackConfiguredState } from "./slack-configured-state.tsx";
import { SlackDeliverySettingsForm } from "./slack-delivery-settings-form.tsx";
import { SlackDeleteSection } from "./slack-delete-section.tsx";
import { SlackManualReplacementForm } from "./slack-manual-replacement-form.tsx";
import { SlackOAuthConnection } from "./slack-oauth-connection.tsx";
import { apiFetch } from "../lib/client-api.ts";

export function SlackSettingsForm({ initial }: { initial?: SlackIntegration }) {
  const router = useRouter();
  const [config, setConfig] = useState<SlackIntegration | undefined>(initial);
  const [pending, start] = useTransition();
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const mounted = useRef(true);
  const configured = Boolean(config);
  const installationMethod = slackInstallationMethod(config);
  const credentials = !configured || installationMethod === "manual";
  const deliveryWarning = slackDeliveryWarning(config);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function save(
    form: HTMLFormElement,
    values: SlackFormValues,
    mode: "settings" | "manual" = credentials ? "manual" : "settings",
  ): Promise<void> {
    try {
      const response = await apiFetch("/api/v1/integrations/slack", {
        method: configured ? (mode === "settings" ? "PATCH" : "PUT") : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          configured && mode === "settings" && config
            ? buildSlackSettingsBody(values, config.version)
            : buildSlackConfigBody(values),
        ),
        cache: "no-store",
      });
      if (!response.ok) {
        const message = await responseMessage(response);
        if (mounted.current) {
          if (mode === "manual") setManualError(message);
          else setDeliveryError(message);
          showToast(message, { variant: "destructive", pw: "slack-error" });
        }
        return;
      }
      const next = (await response.json()) as SlackIntegration;
      if (!mounted.current) return;
      // Reset first so browser password managers and the DOM cannot retain plaintext secrets.
      form.reset();
      setConfig(next);
      setSuccess(slackSaveSuccessMessage(next));
      router.refresh();
    } catch {
      if (mounted.current) {
        if (mode === "manual") setManualError("Unable to save Slack configuration. Try again.");
        else setDeliveryError("Unable to save Slack configuration. Try again.");
        showToast("Unable to save Slack configuration. Try again.", {
          variant: "destructive",
          pw: "slack-error",
        });
      }
    }
  }

  return (
    <Card data-pw="slack-settings-card">
      <CardHeader>
        <CardTitle>Slack configuration</CardTitle>
        <p className="text-sm text-muted-foreground">
          Store the workspace bot token and channel used for session lifecycle delivery.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {deliveryWarning ? (
          <Alert variant="warning" role="note" data-pw="slack-delivery-warning">
            {deliveryWarning}
          </Alert>
        ) : null}

        <SlackConfiguredState config={config} />
        <SlackOAuthConnection
          config={config}
          pending={pending}
          onStart={() => {
            setDeliveryError(null);
            setManualError(null);
            setSuccess(null);
          }}
        />
        <SlackDeliverySettingsForm
          config={config}
          credentials={credentials}
          pending={pending}
          error={credentials ? manualError : deliveryError}
          success={success}
          onError={credentials ? setManualError : setDeliveryError}
          onSave={(form, values) => {
            if (credentials) setManualError(null);
            else setDeliveryError(null);
            setSuccess(null);
            start(() => save(form, values));
          }}
        />

        {config && !credentials ? (
          <SlackManualReplacementForm
            config={config}
            error={manualError}
            pending={pending}
            onError={setManualError}
            onSave={(form, values) => {
              setManualError(null);
              setSuccess(null);
              start(() => save(form, values, "manual"));
            }}
          />
        ) : null}

        {configured ? (
          <SlackDeleteSection
            pending={pending}
            onConfirm={async () => {
              setDeliveryError(null);
              setManualError(null);
              setSuccess(null);
              try {
                const response = await apiFetch("/api/v1/integrations/slack", {
                  method: "DELETE",
                  cache: "no-store",
                });
                if (!response.ok) {
                  const message = await responseMessage(response);
                  if (mounted.current) {
                    showToast(message, { variant: "destructive", pw: "slack-error" });
                  }
                  return;
                }
                if (!mounted.current) return;
                setConfig(undefined);
                setSuccess("Slack configuration deleted.");
                router.refresh();
              } catch {
                if (mounted.current) {
                  showToast("Unable to delete Slack configuration. Try again.", {
                    variant: "destructive",
                    pw: "slack-error",
                  });
                }
              }
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
