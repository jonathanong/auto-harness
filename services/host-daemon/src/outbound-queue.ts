/* eslint-disable max-lines */
import type { HostToServerMessage } from "@auto-harness/shared";

import type { DaemonTransport, SendOptions } from "./daemon-transport-types.ts";

type OutboundItem = {
  message: HostToServerMessage;
  options: SendOptions | undefined;
  bytes: number;
  nonDroppable: boolean;
  delivery: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  onStart: (() => void) | undefined;
};

type ChangeSignal = { promise: Promise<void>; resolve: () => void };
type LossMarker = {
  message: Extract<HostToServerMessage, { type: "session:log" }>;
  count: number;
  started: boolean;
};

const MAX_ITEMS = 1_000;
const MAX_BYTES = 4 * 1024 * 1024;

function changeSignal(): ChangeSignal {
  let resolve: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/**
 * Bounded producer-side FIFO. It serializes transport calls, drops normal
 * logs under pressure, coalesces keepalives, and lets critical producers wait
 * on one shared capacity signal rather than retaining unbounded callbacks.
 */
export class OutboundQueue {
  private readonly items: OutboundItem[] = [];
  private inflight: OutboundItem | undefined;
  private bytes = 0;
  private nextCriticalTicket = 0;
  private criticalTurn = 0;
  private readonly cancelledCriticalTickets = new Set<number>();
  private accepted = 0;
  private settled = 0;
  private change = changeSignal();
  private readonly lossMarkers = new Map<string, LossMarker>();
  private readonly transport: DaemonTransport;
  private readonly report: (line: string) => void;

  constructor(transport: DaemonTransport, report: (line: string) => void) {
    this.transport = transport;
    this.report = report;
  }

  send(message: HostToServerMessage, options?: SendOptions): Promise<void> {
    const existing = this.coalesced(message);
    if (existing) return existing;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    const nonDroppable = options?.nonDroppable === true || message.type !== "session:log";
    if (bytes > MAX_BYTES) {
      if (!nonDroppable) this.recordDroppedLog(message);
      return this.rejected(message, new Error("outbound frame exceeds buffer limit"));
    }
    if (!nonDroppable) {
      if (this.hasWaitingCritical() || !this.fits(bytes)) {
        this.recordDroppedLog(message);
        return this.rejected(message, new Error("outbound buffer full for session:log"));
      }
      return this.admit(message, bytes, false, options);
    }
    return this.enqueueCritical(message, bytes, options);
  }

  get length(): number {
    return this.items.length + (this.inflight ? 1 : 0);
  }

  async flush(): Promise<void> {
    const target = this.accepted;
    while (this.settled < target) await this.change.promise;
  }

  private async enqueueCritical(
    message: HostToServerMessage,
    bytes: number,
    options: SendOptions | undefined,
    onStart?: () => void,
  ): Promise<void> {
    const ticket = this.nextCriticalTicket++;
    while (true) {
      if (options?.signal?.aborted) {
        this.cancelCriticalTicket(ticket);
        throw new Error("outbound frame cancelled");
      }
      if (ticket !== this.criticalTurn) {
        await this.waitForChange(options?.signal);
        continue;
      }
      this.evictLogsUntilFits(bytes);
      if (!this.fits(bytes)) {
        await this.waitForChange(options?.signal);
        continue;
      }
      this.advanceCriticalTurn();
      const delivery = this.admit(message, bytes, true, options, onStart);
      this.notify();
      return delivery;
    }
  }

  private admit(
    message: HostToServerMessage,
    bytes: number,
    nonDroppable: boolean,
    options: SendOptions | undefined,
    onStart?: () => void,
  ): Promise<void> {
    let resolve: () => void;
    let reject: (error: unknown) => void;
    const delivery = new Promise<void>((next, fail) => {
      resolve = next;
      reject = fail;
    });
    const item: OutboundItem = {
      message,
      options,
      bytes,
      nonDroppable,
      delivery,
      resolve,
      reject,
      onStart,
    };
    this.items.push(item);
    this.bytes += bytes;
    this.accepted++;
    this.observeFailure(message, delivery);
    this.pump();
    return delivery;
  }

  private pump(): void {
    if (this.inflight || this.items.length === 0) return;
    const item = this.items.shift()!;
    this.inflight = item;
    item.onStart?.();
    void Promise.resolve()
      .then(() => this.transport.send(item.message, item.options))
      .then(
        () => this.settle(item),
        (error: unknown) => this.settle(item, error),
      );
  }

  private settle(item: OutboundItem, error?: unknown): void {
    if (this.inflight !== item) return;
    this.inflight = undefined;
    this.bytes -= item.bytes;
    this.settled++;
    if (error === undefined) item.resolve();
    else item.reject(error);
    this.notify();
    this.pump();
  }

  private evictLogsUntilFits(bytes: number): void {
    let evicted = false;
    while (!this.fits(bytes)) {
      const index = this.items.findIndex((item) => !item.nonDroppable);
      if (index < 0) return;
      const [dropped] = this.items.splice(index, 1) as [OutboundItem];
      this.bytes -= dropped.bytes;
      this.settled++;
      evicted = true;
      this.recordDroppedLog(
        dropped.message as Extract<HostToServerMessage, { type: "session:log" }>,
      );
      dropped.reject(new Error("outbound log dropped while disconnected"));
    }
    if (evicted) this.notify();
  }

  private coalesced(message: HostToServerMessage): Promise<void> | undefined {
    if (message.type === "host:keepalive") {
      const existing = this.findItem("host:keepalive");
      if (existing) {
        existing.message = message;
        return existing.delivery;
      }
      return undefined;
    }
    if (message.type !== "host:register") return undefined;
    const existing = this.items.find((item) => item.message.type === "host:register");
    if (!existing) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.bytes - existing.bytes + bytes > MAX_BYTES) return undefined;
    this.bytes = this.bytes - existing.bytes + bytes;
    existing.bytes = bytes;
    existing.message = message;
    return existing.delivery;
  }

  private findItem(type: HostToServerMessage["type"]): OutboundItem | undefined {
    if (this.inflight?.message.type === type) return this.inflight;
    return this.items.find((item) => item.message.type === type);
  }

  private recordDroppedLog(message: Extract<HostToServerMessage, { type: "session:log" }>): void {
    const existing = this.lossMarkers.get(message.sessionId);
    if (existing && !existing.started) {
      existing.count++;
      existing.message.content = `${existing.count} log chunk(s) dropped while disconnected`;
      return;
    }
    const marker: LossMarker = {
      message: {
        type: "session:log",
        sessionId: message.sessionId,
        stream: "system",
        content: "1 log chunk(s) dropped while disconnected",
        timestamp: new Date().toISOString(),
        seq: Number.MAX_SAFE_INTEGER,
      },
      count: 1,
      started: false,
    };
    this.lossMarkers.set(message.sessionId, marker);
    this.enqueueLossMarker(marker);
  }

  private enqueueLossMarker(marker: LossMarker): void {
    // Reserve enough accounting for a growing decimal count without letting a
    // marker's own eviction split one overflow burst into multiple notices.
    const bytes = Buffer.byteLength(JSON.stringify(marker.message)) + 10;
    const delivery = this.enqueueCritical(marker.message, bytes, { nonDroppable: true }, () => {
      marker.started = true;
    });
    void delivery
      .catch(() => {})
      .finally(() => {
        if (this.lossMarkers.get(marker.message.sessionId) === marker) {
          this.lossMarkers.delete(marker.message.sessionId);
        }
      });
  }

  private rejected(message: HostToServerMessage, error: Error): Promise<void> {
    const delivery = Promise.reject(error);
    this.observeFailure(message, delivery);
    return delivery;
  }

  private observeFailure(message: HostToServerMessage, delivery: Promise<void>): void {
    void delivery.catch((error: unknown) => {
      this.report(
        `outbound ${message.type} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private waitForChange(signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return this.change.promise;
    const change = this.change.promise;
    return new Promise<void>((resolve) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", wake);
        resolve();
      };
      signal.addEventListener("abort", wake, { once: true });
      void change.then(wake);
    });
  }

  private cancelCriticalTicket(ticket: number): void {
    this.cancelledCriticalTickets.add(ticket);
    while (this.cancelledCriticalTickets.delete(this.criticalTurn)) this.criticalTurn++;
    this.notify();
  }

  private advanceCriticalTurn(): void {
    this.criticalTurn++;
    while (this.cancelledCriticalTickets.delete(this.criticalTurn)) this.criticalTurn++;
  }

  private hasWaitingCritical(): boolean {
    return this.nextCriticalTicket !== this.criticalTurn;
  }

  private fits(bytes: number): boolean {
    return this.length < MAX_ITEMS && this.bytes + bytes <= MAX_BYTES;
  }

  private notify(): void {
    const previous = this.change;
    this.change = changeSignal();
    previous.resolve();
  }
}
