/**
 * Parse optional Sentry DSNs without depending on the Sentry SDK.
 *
 * Unset, blank, and env-file placeholders are off. Invalid non-empty values are
 * distinct so deploy can fail closed while runtimes skip and keep serving.
 */

export type SentryDsnParts = {
  dsn: string;
  host: string;
  pathPrefix: string;
  projectId: string;
  protocol: "http:" | "https:";
  publicKey: string;
};

export type SentryDsnInspection =
  | { kind: "unset" }
  | { kind: "invalid" }
  | { kind: "ok"; dsn: string; parts: SentryDsnParts };

const PLACEHOLDER = /^(?:REPLACE_WITH|PLACEHOLDER|YOUR[_ -]|<[^>]+>|\$\{[^}]+\})/iu;

export function inspectSentryDsn(value: string | undefined): SentryDsnInspection {
  const dsn = value?.trim() ?? "";
  if (!dsn || PLACEHOLDER.test(dsn)) return { kind: "unset" };
  const parts = parseSentryDsn(dsn);
  return parts === undefined ? { kind: "invalid" } : { kind: "ok", dsn, parts };
}

export function optionalSentryDsn(value: string | undefined): string | undefined {
  const inspected = inspectSentryDsn(value);
  return inspected.kind === "ok" ? inspected.dsn : undefined;
}

export function parseSentryDsn(value: string): SentryDsnParts | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const publicKey = decodeURIComponent(url.username);
  if (!publicKey || url.password !== "") return undefined;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const projectId = segments.at(-1);
  if (!projectId || url.search !== "" || url.hash !== "") return undefined;
  const pathPrefix = segments.length > 1 ? `/${segments.slice(0, -1).join("/")}` : "";
  return {
    dsn: value,
    host: url.host,
    pathPrefix,
    projectId,
    protocol: url.protocol,
    publicKey,
  };
}

export function sentryIngestEnvelopeUrl(dsn: string): string | undefined {
  const parts = parseSentryDsn(dsn);
  if (!parts) return undefined;
  return `${parts.protocol}//${parts.host}${parts.pathPrefix}/api/${parts.projectId}/envelope/`;
}

/** Drop cookie and authorization headers from a Sentry event payload. */
export function scrubSentryEvent<T>(event: T): T {
  if (typeof event !== "object" || event === null) return event;
  const headers = (event as { request?: { headers?: Record<string, unknown> } }).request?.headers;
  if (!headers) return event;
  for (const key of Object.keys(headers)) {
    if (/^(cookie|authorization)$/iu.test(key)) delete headers[key];
  }
  return event;
}
