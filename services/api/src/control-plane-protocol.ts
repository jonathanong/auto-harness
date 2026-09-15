import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";

import type { ConnectionRecord } from "./control-plane-types.ts";

/** Accept only the current host protocol. Any other advertisement is rejected. */
export function negotiateHostProtocolVersion(advertisedVersion: number | undefined): number | null {
  return advertisedVersion === HOST_PROTOCOL_VERSION ? HOST_PROTOCOL_VERSION : null;
}

/** The version both peers accepted for this host connection. */
export function connectionProtocolVersion(
  connection: Pick<ConnectionRecord, "protocolVersion" | "negotiatedProtocolVersion"> | undefined,
): number | undefined {
  return connection?.negotiatedProtocolVersion ?? connection?.protocolVersion;
}

export function durableConnectionProtocolVersion(
  connection: Pick<ConnectionRecord, "negotiatedProtocolVersion"> | undefined,
): number | undefined {
  return connection?.negotiatedProtocolVersion;
}

export function isCurrentHostProtocol(version: number | undefined): boolean {
  return version === HOST_PROTOCOL_VERSION;
}
