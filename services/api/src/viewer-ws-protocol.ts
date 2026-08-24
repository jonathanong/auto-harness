import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { AuthService, Principal } from "./auth.ts";

type ViewerMessage =
  | { type: "session:subscribe"; sessionId: string; after?: string }
  | { type: "session:unsubscribe"; sessionId: string };

/** Fail closed when the browser Origin is missing or is not the configured web origin. */
export function isAllowedViewerOrigin(
  originHeader: string | undefined,
  publicBaseUrl: string | undefined,
): boolean {
  const requested = canonicalOrigin(originHeader);
  const allowed = canonicalOrigin(originFromBaseUrl(publicBaseUrl));
  return requested !== null && allowed !== null && requested === allowed;
}

/** Browser sockets only accept an existing browser session, never an agent key. */
export async function authenticateViewer(
  req: IncomingMessage,
  auth: AuthService,
  publicBaseUrl?: string,
): Promise<Principal | null> {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!isAllowedViewerOrigin(origin, publicBaseUrl)) return null;
  const ticket = new URL(req.url ?? "/", "http://localhost").searchParams.get("ticket");
  if (!ticket) {
    if (auth.mode === "required") return null;
    const principal = await auth.authenticate(req);
    return principal && (principal.kind === "admin" || principal.kind === "user")
      ? principal
      : null;
  }
  const principal = await auth.authenticateViewerTicket(ticket);
  return principal && (principal.kind === "admin" || principal.kind === "user") ? principal : null;
}

export function parseViewerMessage(raw: unknown): ViewerMessage | null {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (!validSessionId(value.sessionId)) return null;
    if (value.type === "session:unsubscribe") {
      return { type: value.type, sessionId: value.sessionId };
    }
    if (
      value.type !== "session:subscribe" ||
      (value.after !== undefined && !validCursor(value.after))
    ) {
      return null;
    }
    return {
      type: value.type,
      sessionId: value.sessionId,
      ...(typeof value.after === "string" ? { after: value.after } : {}),
    };
  } catch {
    return null;
  }
}

export function rejectUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

function originFromBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function canonicalOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }
    const hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
    return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return null;
  }
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validCursor(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) return false;
  const separator = value.lastIndexOf("#");
  return (
    separator > 0 &&
    Number.isFinite(Date.parse(value.slice(0, separator))) &&
    /^\d{10,}$/.test(value.slice(separator + 1))
  );
}
