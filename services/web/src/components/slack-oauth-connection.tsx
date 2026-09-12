"use client";

import { useEffect, useRef, useState } from "react";
import { Button, dismissToast, showToast } from "@auto-harness/ui";

import { responseMessage, slackOAuthSettings, type SlackIntegration } from "./slack-settings.ts";
import { apiFetch } from "../lib/client-api.ts";

export function SlackOAuthConnection({
  config,
  pending,
  onStart,
}: {
  config?: SlackIntegration;
  pending: boolean;
  onStart: () => void;
}) {
  const [oauthPending, setOauthPending] = useState(false);
  const mounted = useRef(true);
  const oauthBusy = pending || oauthPending;

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  async function connect(): Promise<void> {
    setOauthPending(true);
    try {
      const response = await apiFetch("/api/v1/integrations/slack/oauth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(slackOAuthSettings(config)),
        cache: "no-store",
      });
      if (!response.ok) {
        if (mounted.current) {
          showToast(await responseMessage(response), { variant: "destructive", pw: "slack-error" });
        }
        return;
      }
      const body = (await response.json()) as { url?: unknown };
      const authorizationUrl = body.url;
      if (
        typeof authorizationUrl !== "string" ||
        !authorizationUrl.startsWith("https://slack.com/oauth/v2/authorize?")
      ) {
        if (mounted.current) {
          showToast("Slack OAuth is not available. Try again later.", {
            variant: "destructive",
            pw: "slack-error",
          });
        }
        return;
      }
      window.location.assign(authorizationUrl);
    } catch {
      if (mounted.current) {
        showToast("Unable to start Slack connection. Try again.", {
          variant: "destructive",
          pw: "slack-error",
        });
      }
    } finally {
      if (mounted.current) setOauthPending(false);
    }
  }

  return (
    <section
      className="grid gap-3 rounded-md border border-border p-4"
      data-pw="slack-connection-options"
    >
      <div>
        <h4 className="font-medium">Connect Slack</h4>
        <p className="text-sm text-muted-foreground">
          Connect the workspace with OAuth to enable verified inbound mentions and direct messages.
          Slack will return here after authorization.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={oauthBusy}
        data-pw={config?.installationMethod === "oauth" ? "slack-reconnect" : "slack-connect"}
        onClick={() => {
          dismissToast();
          onStart();
          void connect();
        }}
      >
        {oauthBusy
          ? "Connecting…"
          : config?.installationMethod === "oauth"
            ? "Reconnect with Slack"
            : "Connect with Slack"}
      </Button>
      <p className="text-sm text-muted-foreground" data-pw="slack-manual-path">
        Prefer to manage credentials yourself? Use the manual bot-token and signing-secret form
        below. Both connection methods remain available.
      </p>
    </section>
  );
}
