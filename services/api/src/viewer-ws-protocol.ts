import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { AuthService, Principal } from "./auth.ts";

export type ViewerSubscribe = { type: "viewer:subscribe"; sessionId: string; after?: string };
export type ViewerMessage = ViewerSubscribe | { type: "viewer:unsubscribe"; sessionId: string };

export async function authenticateViewer(
  req: IncomingMessage,
  auth: AuthService,
): Promise<Principal | null> {
  const principal = await auth.authenticate(req);
  // Host-bound service accounts are transport credentials for the mutation
  // channel only. Do not let a stolen agent key become a log-viewing token.
  return principal?.kind === "service-account" ? null : principal;
}

export function parseViewerMessage(raw: unknown): ViewerMessage | null {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.sessionId !== "string" ||
      value.sessionId.length === 0 ||
      value.sessionId.length > 512
    )
      return null;
    if (value.type === "viewer:unsubscribe")
      return { type: value.type, sessionId: value.sessionId };
    if (value.type !== "viewer:subscribe" || (value.after !== undefined && !isCursor(value.after)))
      return null;
    return {
      type: value.type,
      sessionId: value.sessionId,
      ...(value.after ? { after: value.after } : {}),
    };
  } catch {
    return null;
  }
}

export function rejectUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

function isCursor(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) return false;
  const separator = value.lastIndexOf("#");
  return (
    separator > 0 &&
    Number.isFinite(Date.parse(value.slice(0, separator))) &&
    /^\d{10,}$/.test(value.slice(separator + 1))
  );
}
