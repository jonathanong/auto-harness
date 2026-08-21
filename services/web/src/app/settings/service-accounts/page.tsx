import { ServiceAccountSettings } from "../../../components/service-account-settings.tsx";
import { canManageAccounts, loadSettingsPrincipal } from "../settings-auth.ts";

export const dynamic = "force-dynamic";

export default async function ServiceAccountsSettingsPage() {
  const principal = await loadSettingsPrincipal();
  if (!principal) return null;
  return <ServiceAccountSettings canManage={canManageAccounts(principal)} />;
}
