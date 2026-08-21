import type { UserRole } from "@auto-harness/shared";

export type Role = UserRole;

export type Principal = {
  id: string;
  username: string;
  role: Role;
  kind: "admin" | "user" | "service-account";
  allowedRepositoryIds?: string[];
  boundHostId?: string;
};
