import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { AuthService, Principal } from "./auth.ts";

type ViewerMessage =
  | { type: "session:subscribe"; sessionId: string; after?: string }
  | { type: "session:unsubscribe"; sessionId: string };

/** Browser sockets only accept an existing browser session, never an agent key. */
export async function authenticateViewer(
  req: IncomingMessage,
  auth: AuthService,
): Promise<Principal | null> {
  const ticket = new URL(req.url ?? "/", "http://localhost").searchParams.get("ticket");
  const principal = ticket
    ? await auth.authenticateViewerTicket(ticket)
    : await auth.authenticate(req);
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
