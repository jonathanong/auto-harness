import { Card, CardContent, CardHeader, CardTitle } from "@auto-harness/ui";

import { ChangePasswordForm } from "../../../components/change-password-form.tsx";
import { loadSettingsPrincipal } from "../settings-auth.ts";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const principal = await loadSettingsPrincipal();
  return (
    <>
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
    </>
  );
}
