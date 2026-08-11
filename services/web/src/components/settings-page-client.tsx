"use client";

import { useEffect, useState } from "react";
import type { PublicSlackIntegration } from "@auto-harness/shared";

import { SlackSettingsForm } from "./slack-settings-form.tsx";

type SettingsState =
  | { kind: "loading" }
  | { kind: "ready"; integration?: PublicSlackIntegration }
  | { kind: "forbidden" }
  | { kind: "error" };

export function SettingsPageClient() {
  const [state, setState] = useState<SettingsState>({ kind: "loading" });

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
          setState({ kind: "ready" });
          return;
        }
        if (!response.ok) {
          setState({ kind: "error" });
          return;
        }
        setState({ kind: "ready", integration: (await response.json()) as PublicSlackIntegration });
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
      <SlackSettingsForm {...(state.integration ? { initial: state.integration } : {})} />
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
  if (typeof window === "undefined") return;
  const returnTo = safeSettingsReturnPath(window.location.pathname, window.location.search);
  window.location.assign(`/login?${new URLSearchParams({ returnTo })}`);
}
