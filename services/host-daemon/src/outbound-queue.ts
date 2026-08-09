import type { HostToServerMessage } from "@auto-harness/shared";

import type { DaemonTransport } from "./daemon-transport.ts";

/** Preserve wire order without allowing one failed send to poison the queue. */
export class OutboundQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly transport: DaemonTransport;
  private readonly report: (line: string) => void;

  constructor(transport: DaemonTransport, report: (line: string) => void) {
    this.transport = transport;
    this.report = report;
  }

  send(message: HostToServerMessage): Promise<void> {
    const delivery = this.tail.then(async () => {
      await this.transport.send(message);
    });
    // The caller must observe its own send failure (ack/status/register are
    // protocol transitions), while a recovered tail allows a later reconnect
    // delivery to proceed.
    this.tail = delivery.catch((err: unknown) => {
      this.report(
        `outbound ${message.type} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return delivery;
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}
