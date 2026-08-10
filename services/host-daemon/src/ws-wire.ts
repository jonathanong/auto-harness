import type { HostToServerMessage } from "@auto-harness/shared";
import WebSocket from "ws";

export function writeWs(target: WebSocket, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      target.send(payload, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export type RegisterMessage = Extract<HostToServerMessage, { type: "host:register" }>;
