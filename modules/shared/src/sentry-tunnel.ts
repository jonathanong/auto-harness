import { optionalSentryDsn, sentryIngestEnvelopeUrl } from "./sentry-dsn.ts";

export const SENTRY_TUNNEL_PATH = "/sentry-tunnel";
export const SENTRY_TUNNEL_MAX_BYTES = 100 * 1024;

export type SentryTunnelResult =
  | { status: 400 | 403 | 404 | 405 | 413 }
  | { status: 200; ingestUrl: string };

export function isSentryTunnelPath(pathname: string): boolean {
  return pathname === SENTRY_TUNNEL_PATH || pathname === `${SENTRY_TUNNEL_PATH}/`;
}

export async function forwardSentryTunnel(input: {
  body: string;
  configuredDsn: string | undefined;
  fetchFn?: typeof fetch;
  method: string;
}): Promise<{ status: number }> {
  const result = evaluateSentryTunnel(input);
  if (result.status !== 200) return { status: result.status };
  try {
    const upstream = await (input.fetchFn ?? fetch)(result.ingestUrl, {
      body: input.body,
      headers: { "content-type": "application/x-sentry-envelope" },
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    return { status: upstream.ok ? 200 : 502 };
  } catch {
    return { status: 502 };
  }
}

export function evaluateSentryTunnel(input: {
  body: string;
  configuredDsn: string | undefined;
  method: string;
}): SentryTunnelResult {
  if (input.method !== "POST") return { status: 405 };
  const dsn = optionalSentryDsn(input.configuredDsn);
  if (!dsn) return { status: 404 };
  const bytes = Buffer.byteLength(input.body, "utf8");
  if (bytes === 0) return { status: 400 };
  if (bytes > SENTRY_TUNNEL_MAX_BYTES) return { status: 413 };
  const headerDsn = envelopeHeaderDsn(input.body);
  if (headerDsn === "invalid") return { status: 400 };
  if (headerDsn !== undefined && headerDsn !== dsn) return { status: 403 };
  const ingestUrl = sentryIngestEnvelopeUrl(dsn);
  if (!ingestUrl) return { status: 400 };
  return { status: 200, ingestUrl };
}

function envelopeHeaderDsn(body: string): string | undefined | "invalid" {
  const newline = body.indexOf("\n");
  const headerLine = newline === -1 ? body : body.slice(0, newline);
  try {
    const header: unknown = JSON.parse(headerLine);
    if (typeof header !== "object" || header === null) return "invalid";
    if (!("dsn" in header) || header.dsn === undefined) return undefined;
    return typeof header.dsn === "string" ? header.dsn : "invalid";
  } catch {
    return "invalid";
  }
}
