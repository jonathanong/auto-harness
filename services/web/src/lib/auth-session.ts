export const SESSION_COOKIE = "auto_harness_session";

/** Permit only an in-app absolute path as a post-login destination. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  return value;
}

export function loginPath(returnTo: string): string {
  return `/login?${new URLSearchParams({ returnTo: safeReturnPath(returnTo) }).toString()}`;
}

/** Edge-compatible JWT verification for the web middleware. */
export async function hasValidSession(
  token: string | undefined,
  secret: string | undefined,
): Promise<boolean> {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts as [string, string, string];
  if (!header || !payload || !signature) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      arrayBuffer(new TextEncoder().encode(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      arrayBuffer(base64urlBytes(signature)),
      arrayBuffer(new TextEncoder().encode(`${header}.${payload}`)),
    );
    if (!verified) return false;
    const protectedHeader = parseJson(header) as { alg?: unknown; typ?: unknown } | null;
    const claims = parseJson(payload) as {
      id?: unknown;
      username?: unknown;
      role?: unknown;
      kind?: unknown;
      exp?: unknown;
    } | null;
    return (
      protectedHeader?.alg === "HS256" &&
      protectedHeader.typ === "JWT" &&
      typeof claims?.id === "string" &&
      typeof claims.username === "string" &&
      (claims.role === "admin" || claims.role === "operator" || claims.role === "read-only") &&
      (claims.kind === "admin" || claims.kind === "user" || claims.kind === "service-account") &&
      typeof claims.exp === "number" &&
      claims.exp > Date.now() / 1000
    );
  } catch {
    return false;
  }
}

function parseJson(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64urlBytes(part))) as unknown;
}

function base64urlBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
