import { COMMAND_START_AUTHORIZATION_PROTOCOL_VERSION } from "@auto-harness/shared";

/**
 * Only daemons that support the durable command-start handshake can safely be
 * replayed after a host loss. Legacy/v2 assignments are already authorized at
 * delivery time, so replaying them could execute the command twice.
 */
export function commandStartStateForProtocol(
  protocolVersion: number | undefined,
): "pending" | "authorized" {
  return protocolVersion !== undefined &&
    protocolVersion >= COMMAND_START_AUTHORIZATION_PROTOCOL_VERSION
    ? "pending"
    : "authorized";
}
