import { apiGet } from "../../lib/api.ts";

type SettingsPrincipal = {
  username: string;
  role: "admin" | "operator" | "read-only";
  kind: "admin" | "user" | "service-account";
  allowedRepositoryIds?: string[];
  boundHostId?: string;
};

export async function loadSettingsPrincipal(): Promise<SettingsPrincipal | undefined> {
  return process.env.HARNESS_AUTH_MODE === "required"
    ? await apiGet<SettingsPrincipal>("/api/v1/auth/me")
    : undefined;
}

export function canManageAccounts(principal: SettingsPrincipal): boolean {
  return (
    principal.role === "admin" && !principal.allowedRepositoryIds?.length && !principal.boundHostId
  );
}
