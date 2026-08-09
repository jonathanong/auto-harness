export type Role = "read-only" | "operator" | "admin";

export type Principal = {
  id: string;
  username: string;
  role: Role;
  kind: "admin" | "user" | "service-account";
  allowedRepositoryIds?: string[];
  boundHostId?: string;
};
