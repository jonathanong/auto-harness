import { UserAccountSettings } from "../../../components/user-account-settings.tsx";
import { canManageAccounts, loadSettingsPrincipal } from "../settings-auth.ts";

export const dynamic = "force-dynamic";

export default async function UserAccountsSettingsPage() {
  const principal = await loadSettingsPrincipal();
  if (!principal) return null;
  return <UserAccountSettings canManage={canManageAccounts(principal)} />;
}
