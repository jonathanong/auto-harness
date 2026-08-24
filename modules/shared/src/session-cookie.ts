import { isUserRole } from "./validation.ts";

export const SESSION_COOKIE = "auto_harness_session";

/** Extract the session cookie value from a Cookie header. */
export function sessionCookieValue(cookieHeader: string | null | undefined): string | undefined {
  return cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}

/**
 * Edge-compatible JWT verification for UI middleware and host-pane browse.
 * Session JWTs must be kind admin or user with no audience.
 */
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
      audience?: unknown;
    } | null;
    return (
      protectedHeader?.alg === "HS256" &&
      protectedHeader.typ === "JWT" &&
      typeof claims?.id === "string" &&
      typeof claims.username === "string" &&
      isUserRole(claims.role) &&
      (claims.kind === "admin" || claims.kind === "user") &&
      claims.audience === undefined &&
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
