// Defense in depth. `GET /auth/me` spreads the server's principal object into its response.
// That principal is sanitized today — verified live, it carries no password or API-key hash —
// but the stored records behind it do hold `passwordHash` / `apiKeyHash`, and the client cannot
// see a future server change that lets one through. So `whoami` and `doctor` print only these
// named fields rather than trusting the response shape.
const ALLOWED_PRINCIPAL_FIELDS = [
  "id",
  "kind",
  "username",
  "name",
  "role",
  "capabilities",
  "boundHostId",
  "allowedRepositoryIds",
];

export function allowlistPrincipal(principal) {
  const allowed = {};
  if (!principal || typeof principal !== "object") return allowed;
  for (const field of ALLOWED_PRINCIPAL_FIELDS) {
    if (Object.hasOwn(principal, field)) allowed[field] = principal[field];
  }
  return allowed;
}

export function formatWhoami(principal) {
  const lines = [];
  for (const field of ALLOWED_PRINCIPAL_FIELDS) {
    if (!Object.hasOwn(principal, field)) continue;
    const value = principal[field];
    lines.push(`${field}: ${Array.isArray(value) ? value.join(", ") : value}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "(no fields returned)\n";
}
