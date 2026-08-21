import {
  USER_ROLES,
  USER_ROLE_DESCRIPTIONS,
  USER_ROLE_LABELS,
  type UserRole,
} from "@auto-harness/shared";
import { Label } from "@auto-harness/ui";

const HUMAN_ROLES: UserRole[] = ["read-only", "author", "operator", "maintainer", "admin"];
const SERVICE_ROLES: UserRole[] = [...USER_ROLES];

export function RoleSelect({
  id,
  name = "role",
  defaultValue = "operator",
  includeAgent = false,
  pw,
  onChange,
}: {
  id: string;
  name?: string;
  defaultValue?: UserRole;
  includeAgent?: boolean;
  pw: string;
  onChange?: (role: UserRole) => void;
}) {
  const roles = includeAgent ? SERVICE_ROLES : HUMAN_ROLES;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Role</Label>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue}
        className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
        data-pw={pw}
        onChange={(event) => onChange?.(event.target.value as UserRole)}
      >
        {roles.map((role) => (
          <option key={role} value={role}>
            {USER_ROLE_LABELS[role]} — {USER_ROLE_DESCRIPTIONS[role]}
          </option>
        ))}
      </select>
    </div>
  );
}
