import type { IncomingMessage, ServerResponse } from "node:http";

import { LOCAL_AGENT_WEB_HTTP, LOCAL_WEB_HTTP } from "@auto-harness/shared";

const NAMED_LOCAL_ORIGINS = new Set([
  LOCAL_WEB_HTTP,
  LOCAL_AGENT_WEB_HTTP,
  "http://localhost:7421",
  "http://localhost:7423",
]);

/** True for local browser origins (127.0.0.1 / localhost any port). */
function isLocalDevOrigin(origin: string): boolean {
  if (NAMED_LOCAL_ORIGINS.has(origin)) {
    return true;
  }
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return false;
    }
    return u.hostname === "127.0.0.1" || u.hostname === "localhost";
  } catch {
    return false;
  }
}

/**
 * Apply CORS for local web UIs calling the API. Handles OPTIONS preflight.
 * Returns true if the request was fully handled (OPTIONS).
 */
export function applyLocalCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers?.origin;
  if (typeof origin === "string" && isLocalDevOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Accept, X-Requested-With",
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}
