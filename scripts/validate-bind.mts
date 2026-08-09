const variable = process.argv[2];
if (!variable) throw new Error("host environment variable name is required");

const host = process.env[variable] ?? "127.0.0.1";
const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
if (!loopback) {
  if (process.env.HARNESS_AUTH_MODE !== "required" || !process.env.HARNESS_ADMINS) {
    throw new Error(
      `${variable}=${host} requires HARNESS_AUTH_MODE=required with session/admin configuration`,
    );
  }
  const secret = process.env.HARNESS_SESSION_SECRET ?? "";
  if (secret.length < 32) {
    throw new Error(`${variable}=${host} requires a session secret of at least 32 characters`);
  }
  let admins: unknown;
  try {
    admins = JSON.parse(Buffer.from(process.env.HARNESS_ADMINS, "base64url").toString("utf8"));
  } catch {
    throw new Error("HARNESS_ADMINS must be a base64url-encoded JSON array");
  }
  if (
    !Array.isArray(admins) ||
    admins.length === 0 ||
    admins.some(
      (admin) =>
        !admin ||
        typeof admin !== "object" ||
        typeof (admin as { username?: unknown }).username !== "string" ||
        typeof (admin as { password?: unknown }).password !== "string" ||
        !isValidCredential((admin as { username: string }).username) ||
        !isValidCredential((admin as { password: string }).password),
    )
  ) {
    throw new Error("HARNESS_ADMINS must contain at least one username/password entry");
  }
}

function isValidCredential(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  );
}
