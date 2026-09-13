import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";

import type { ConnectionRecord } from "./control-plane-types.ts";

/** The version both peers accepted for this host connection. */
export function negotiateHostProtocolVersion(advertisedVersion: number | undefined): number {
  return Math.min(advertisedVersion ?? 0, HOST_PROTOCOL_VERSION);
}

/**
 * Reads the durable negotiation result. Old rows predate that field and can
 * use their advertised version only until hydration stamps the safe fallback.
 */
export function connectionProtocolVersion(
  connection: Pick<ConnectionRecord, "protocolVersion" | "negotiatedProtocolVersion"> | undefined,
): number {
  return connection?.negotiatedProtocolVersion ?? connection?.protocolVersion ?? 0;
}

/** Durable rows without an explicit negotiation predate negotiated protocol storage. */
export function durableConnectionProtocolVersion(
  connection: Pick<ConnectionRecord, "negotiatedProtocolVersion"> | undefined,
): number {
  return connection?.negotiatedProtocolVersion ?? 0;
}
