import { isLoopbackOrigin } from "../loopback.js";
import { CliConfigError, CliUsageError } from "./cli-errors.js";
import { readStdin } from "./read-stdin.js";

// Matches `AutoHarnessClient`'s default `requestTimeoutMs`.
const ADMIN_LOGIN_TIMEOUT_MS = 30_000;

/**
 * Usage-error checks for `--admin-password-stdin`, run before any request. An admin login is an
 * alternate *identity*, not an additional one, so it is ambiguous to also have an API key
 * configured — and it needs stdin for the password, so it conflicts with any command that also
 * reads stdin for its own input (pass that command's own description as `stdinClaimedBy`, e.g.
 * `"api --body-file -"`).
 */
export function checkAdminLoginUsage(flags, env, stdinClaimedBy) {
  if (!flags["--admin-password-stdin"]) return;
  // Presence, not truthiness: an empty `--api-key-file=` is still an explicit (broken) request
  // for API-key identity, and must not slip past this ambiguity check.
  if (Object.hasOwn(flags, "--api-key-file") || env.HARNESS_API_KEY || env.HARNESS_API_KEY_FILE) {
    throw new CliUsageError(
      "--admin-password-stdin cannot be combined with an API key (--api-key-file, " +
        "HARNESS_API_KEY, or HARNESS_API_KEY_FILE); pick one identity",
    );
  }
  if (stdinClaimedBy) {
    throw new CliUsageError(
      `--admin-password-stdin and ${stdinClaimedBy} both need stdin; pass one of them another way`,
    );
  }
}

/**
 * `POST /auth/login` with the password read from stdin (one trailing newline stripped), then
 * returns a `fetch` that carries the session cookie on every later request. The login response
 * body carries the principal but is deliberately never read — see the CLI spec — so a non-200 is
 * reported by status code alone, never by inspecting or printing the body.
 */
export async function loginAsAdmin(io, baseUrl, username, allowInsecureHttp = false) {
  // The password is a credential, so it gets the same transport rule the client applies to an
  // API key (`assertSecureTransport` in loopback.js): https, or plain http only to a loopback
  // host and only with --allow-insecure-http. Admin mode sets no API key, so the client's own
  // check never fires here. Checked before stdin is read, so a refused URL never consumes the
  // password, and the session cookie that comes back is bound to the same transport.
  if (!baseUrl.startsWith("https://") && !(allowInsecureHttp && isLoopbackOrigin(baseUrl))) {
    throw new CliConfigError(
      "--admin-password-stdin requires an https API URL (--allow-insecure-http only permits " +
        "plain HTTP to a loopback host, e.g. http://127.0.0.1 or http://localhost)",
    );
  }
  const rawPassword = await readStdin(io.stdin);
  const password = rawPassword.endsWith("\n") ? rawPassword.slice(0, -1) : rawPassword;
  const origin = baseUrl.replace(/\/$/, "").replace(/\/api\/v1$/, "");
  // A raw fetch, so it needs its own bound — the same one `doctor`'s /health probe uses —
  // or a stalled server hangs the command before `AutoHarnessClient`'s timeout ever applies.
  const response = await io.fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: (io.timeoutSignal ?? AbortSignal.timeout)(ADMIN_LOGIN_TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error(`admin login failed (HTTP ${response.status})`);
  const cookieHeader = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0].trim())
    .join("; ");
  return {
    username,
    fetch: (url, init = {}) =>
      io.fetch(url, { ...init, headers: { ...init.headers, cookie: cookieHeader } }),
  };
}
