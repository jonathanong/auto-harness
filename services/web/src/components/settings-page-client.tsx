"use client";

import { useEffect, useState } from "react";
import type { PublicSlackIntegration } from "@auto-harness/shared";
import { showToast } from "@auto-harness/ui";

import { SlackSettingsForm } from "./slack-settings-form.tsx";

type SettingsState =
  | { kind: "loading" }
  | { kind: "ready"; integration?: PublicSlackIntegration; oauthAvailable: boolean }
  | { kind: "forbidden" }
  | { kind: "error" };

/**
 * A response with no body (or one that fails to parse) degrades to an empty object rather
 * than throwing, so a malformed or legacy fixture response disables the OAuth button
 * instead of failing the whole settings page load.
 */
async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Present on every GET, configured or not — see local-routes-slack-integration.ts. */
function readOAuthAvailable(body: Record<string, unknown>): boolean {
  return Boolean(body.oauthAvailable);
}

export function SettingsPageClient() {
  const [state, setState] = useState<SettingsState>({ kind: "loading" });

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const result = query.get("slackOAuth");
    const messages: Record<string, { message: string; variant?: "destructive" }> = {
      success: { message: "Slack connected. Delivery and inbound events are ready to configure." },
      error: {
        message: "Slack could not complete the connection. Try again.",
        variant: "destructive",
      },
    };
    const status = result ? messages[result] : undefined;
    if (status) {
      showToast(status.message, {
        ...(status.variant ? { variant: status.variant } : {}),
        pw: "slack-oauth-status",
      });
    }
    if (result !== null) {
      query.delete("slackOAuth");
      const next = query.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${next ? `?${next}` : ""}`);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/integrations/slack", { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        if (response.status === 403) {
          setState({ kind: "forbidden" });
          return;
        }
        if (response.status === 404) {
          setState({
            kind: "ready",
            oauthAvailable: readOAuthAvailable(await readJsonBody(response)),
          });
          return;
        }
        if (!response.ok) {
          setState({ kind: "error" });
          return;
        }
        const body = await readJsonBody(response);
        setState({
          kind: "ready",
          integration: body as PublicSlackIntegration,
          oauthAvailable: readOAuthAvailable(body),
        });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, []);

  if (state.kind === "loading") {
    return <div className="space-y-3" aria-busy="true" data-pw="slack-settings-loading" />;
  }
  if (state.kind === "forbidden") {
    return (
      <div className="space-y-3" data-pw="slack-settings-forbidden">
        <h3 className="text-lg font-medium">Slack integration</h3>
        <p className="text-sm text-red-700" role="alert" data-pw="settings-forbidden-error">
          You do not have permission to manage global settings. Slack configuration requires an
          unscoped admin account.
        </p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="space-y-3" data-pw="slack-settings-error">
        <h3 className="text-lg font-medium">Slack integration</h3>
        <p className="text-sm text-red-700" role="alert" data-pw="settings-load-error">
          Unable to load settings. Try again later.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-6" data-pw="slack-settings-section">
      <SlackSettingsForm
        {...(state.integration ? { initial: state.integration } : {})}
        oauthAvailable={state.oauthAvailable}
      />
    </div>
  );
}

/** Preserve only an internal relative path in the login return parameter. */
export function safeSettingsReturnPath(pathname: string, search = ""): string {
  const current = `${pathname}${search}`;
  return current.startsWith("/") && !current.startsWith("//") && !current.includes("\\")
    ? current
    : "/settings";
}

function redirectToLogin(): void {
  const returnTo = safeSettingsReturnPath(window.location.pathname, window.location.search);
  window.location.assign(`/login?${new URLSearchParams({ returnTo })}`);
}
