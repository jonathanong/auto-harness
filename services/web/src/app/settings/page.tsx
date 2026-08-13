import { Card, CardContent, CardHeader, CardTitle } from "@auto-harness/ui";

import { ChangePasswordForm } from "../../components/change-password-form.tsx";
import { ServiceAccountSettings } from "../../components/service-account-settings.tsx";
import { SettingsPageClient } from "../../components/settings-page-client.tsx";
import { apiGet } from "../../lib/api.ts";

type Principal = {
  username: string;
  role: "admin" | "operator" | "read-only";
  kind: "admin" | "user" | "service-account";
  allowedRepositoryIds?: string[];
  boundHostId?: string;
};

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const principal =
    process.env.HARNESS_AUTH_MODE === "required"
      ? await apiGet<Principal>("/api/v1/auth/me")
      : undefined;
  return (
    <div className="mx-auto max-w-5xl space-y-6" data-pw="page-settings">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="settings-heading">
          Settings
        </h2>
        <p className="text-sm text-muted-foreground">Your control-plane account.</p>
      </div>
      {principal ? (
        <Card data-pw="account-details">
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p data-pw="account-username">{principal.username}</p>
            <p data-pw="account-role">{principal.role}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Authentication disabled</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Loopback development mode does not use a signed account session.
          </CardContent>
        </Card>
      )}
      {principal ? (
        principal.kind === "user" ? (
          <Card data-pw="change-password-card">
            <CardHeader>
              <CardTitle>Change password</CardTitle>
            </CardHeader>
            <CardContent>
              <ChangePasswordForm />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Password rotation</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Bootstrap admin passwords are rotated through HARNESS_ADMINS and a redeploy.
            </CardContent>
          </Card>
        )
      ) : null}
      <ServiceAccountSettings
        canManage={
          !principal ||
          (principal.role === "admin" &&
            !principal.allowedRepositoryIds?.length &&
            !principal.boundHostId)
        }
      />
      <SettingsPageClient />
    </div>
  );
}
