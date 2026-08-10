import type { HostToServerMessage } from "@auto-harness/shared";

import type { DaemonTransport, SendOptions } from "./daemon-transport-types.ts";

/**
 * Lightweight daemon-facing write facade. WsTransport owns the one bounded
 * outbound FIFO, including loss accounting and backpressure; this facade only
 * lets a session wait until writes it has already started have settled.
 */
export class OutboundQueue {
  private readonly pending = new Set<Promise<void>>();
  private readonly transport: DaemonTransport;
  private readonly report: (line: string) => void;

  constructor(transport: DaemonTransport, report: (line: string) => void) {
    this.transport = transport;
    this.report = report;
  }

  send(message: HostToServerMessage, options?: SendOptions): Promise<void> {
    const delivery = this.transport.send(message, options);
    this.pending.add(delivery);
    void delivery
      .catch((error: unknown) => {
        this.report(
          `outbound ${message.type} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.pending.delete(delivery));
    return delivery;
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled(this.pending);
  }
}
