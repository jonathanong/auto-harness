"use client";

import { useEffect, useState } from "react";
import { type PublicSlackIntegration } from "@auto-harness/shared";

import { SlackSettingsForm } from "./slack-settings-form.tsx";

export function SettingsPageClient() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; integration?: PublicSlackIntegration }
    | { kind: "unauthenticated" }
    | { kind: "forbidden" }
    | { kind: "error" }
  >({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/integrations/slack", { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401) {
          redirectToLogin();
          setState({ kind: "unauthenticated" });
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
    return <div className="space-y-3" aria-busy="true" />;
  }
  if (state.kind === "unauthenticated") {
    return (
      <div className="space-y-3">
        <h2 className="text-2xl font-semibold tracking-tight">Sign in required</h2>
        <p className="text-sm text-muted-foreground" role="status">
          Redirecting to sign in…
        </p>
      </div>
    );
  }
  if (state.kind === "forbidden") {
    return (
      <div className="space-y-3" data-pw="page-settings-forbidden">
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="text-sm text-red-700" role="alert" data-pw="settings-forbidden-error">
          You do not have permission to manage global settings. Slack configuration requires an
          unscoped admin account.
        </p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="space-y-3" data-pw="page-settings-error">
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="text-sm text-red-700" role="alert" data-pw="settings-load-error">
          Unable to load settings. Try again later.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-6" data-pw="page-settings">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="settings-heading">
          Settings
        </h2>
        <p className="text-sm text-muted-foreground">
          Global control-plane settings. Slack configuration is restricted to unscoped admins.
        </p>
      </div>
      <SlackSettingsForm {...(state.integration ? { initial: state.integration } : {})} />
    </div>
  );
}

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const current = `${window.location.pathname}${window.location.search}`;
  const safeReturnTo =
    current.startsWith("/") && !current.startsWith("//") && !current.includes("\\") ? current : "/";
  window.location.assign(`/login?${new URLSearchParams({ returnTo: safeReturnTo })}`);
}
