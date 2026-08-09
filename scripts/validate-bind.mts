const variable = process.argv[2];
if (!variable) throw new Error("host environment variable name is required");

const host = process.env[variable] ?? "127.0.0.1";
const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
if (!loopback) {
  if (
    process.env.HARNESS_AUTH_MODE !== "required" ||
    !process.env.HARNESS_SESSION_SECRET ||
    !process.env.HARNESS_ADMINS
  ) {
    throw new Error(
      `${variable}=${host} requires HARNESS_AUTH_MODE=required with session/admin configuration`,
    );
  }
}
