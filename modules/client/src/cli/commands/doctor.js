import { AutoHarnessClient, AutoHarnessError } from "../../index.js";
import { allowlistPrincipal } from "../allowlist.js";
import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS, resolveConfig } from "../config.js";

// A raw API Gateway endpoint bypasses CloudFront, which is what injects the ingress token; the
// host daemon's own usage text says never to use one (see cli-usage.ts).
const EXECUTE_API_HOST = /\.execute-api\.[^.]+\.amazonaws\.com$/i;

/** Runs the url/reachability/auth checks and prints one `<status> <name>: <reason>` line each.
 * Returns 1 if any check `fail`s, else 0 — a `warn` never fails the overall run. */
export async function runDoctor(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: GLOBAL_VALUE_FLAGS,
    booleanFlags: GLOBAL_BOOLEAN_FLAGS,
  });
  if (positionals.length > 0) {
    throw new CliUsageError(`doctor takes no arguments; received: ${positionals.join(" ")}`);
  }
  const config = await resolveConfig(flags, io);
  const checks = [
    checkUrlShape(config.baseUrl, config.allowInsecureHttp),
    await checkReachability(config.baseUrl, io.fetch),
    await checkAuth(config, io.fetch),
  ];
  for (const check of checks) io.stdout.write(formatCheck(check));
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

/** `AutoHarnessClient` strips a trailing `/api/v1` from `baseUrl` itself; `/health` lives at the
 * site root, so this mirrors that same normalization for the raw (non-`client.request`) fetch. */
function siteOrigin(baseUrl) {
  return baseUrl.replace(/\/$/, "").replace(/\/api\/v1$/, "");
}

function checkUrlShape(baseUrl, allowInsecureHttp) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return { name: "url", status: "fail", message: `${baseUrl} is not a valid URL` };
  }
  if (url.protocol === "http:" && !allowInsecureHttp) {
    return {
      name: "url",
      status: "fail",
      message: "baseUrl uses http:// (pass --allow-insecure-http only for local/loopback dev)",
    };
  }
  if (EXECUTE_API_HOST.test(url.hostname)) {
    return {
      name: "url",
      status: "warn",
      message:
        "raw API Gateway URL bypasses CloudFront, which injects the ingress token, so " +
        "requests will be rejected; use the CloudFront WebUrl from the deploy output instead",
    };
  }
  return { name: "url", status: "ok", message: `using ${baseUrl}` };
}

async function checkReachability(baseUrl, fetchFn) {
  const url = `${siteOrigin(baseUrl)}/health`;
  let response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    return {
      name: "reachability",
      status: "fail",
      message: `GET /health failed: ${error.message}`,
    };
  }
  if (response.status !== 200) {
    return {
      name: "reachability",
      status: "fail",
      message: `GET /health returned HTTP ${response.status}`,
    };
  }
  const body = await response.json().catch(() => undefined);
  if (!body || body.ok !== true) {
    return {
      name: "reachability",
      status: "fail",
      message: 'GET /health did not return {"ok":true}',
    };
  }
  return { name: "reachability", status: "ok", message: "control plane is reachable" };
}

async function checkAuth(config, fetchFn) {
  if (!config.apiKey) {
    return {
      name: "auth",
      status: "warn",
      message: "no API key configured; only unauthenticated checks ran",
    };
  }
  let client;
  try {
    client = new AutoHarnessClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      fetch: fetchFn,
      allowInsecureHttp: config.allowInsecureHttp,
    });
  } catch (error) {
    return { name: "auth", status: "fail", message: error.message };
  }
  try {
    const principal = allowlistPrincipal(await client.request("/auth/me"));
    const role = principal.role ?? "unknown";
    const capabilities = Array.isArray(principal.capabilities)
      ? principal.capabilities.join(", ")
      : "none";
    return {
      name: "auth",
      status: "ok",
      message: `authenticated as role ${role} (capabilities: ${capabilities})`,
    };
  } catch (error) {
    if (error instanceof AutoHarnessError && error.status === 401) {
      return { name: "auth", status: "fail", message: "API key rejected" };
    }
    return { name: "auth", status: "fail", message: `GET /auth/me failed: ${error.message}` };
  }
}

function formatCheck({ status, name, message }) {
  return `${status} ${name}: ${message}\n`;
}
