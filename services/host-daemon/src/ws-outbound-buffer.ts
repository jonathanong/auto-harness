/* eslint-disable max-lines */
import type { HostToServerMessage } from "@auto-harness/shared";

type WsBufferOptions = {
  /** A recovery notice is a log on the wire, but must survive subsequent
   * pressure just like a protocol transition. */
  nonDroppable?: boolean;
  signal?: AbortSignal;
};

type CapacitySignal = { promise: Promise<void>; resolve: () => void };

function capacitySignal(): CapacitySignal {
  let resolve: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export type WsBufferItem = {
  message: HostToServerMessage;
  bytes: number;
  nonDroppable: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  dispose: () => void;
  cancelled: () => boolean;
};

const MAX_ITEMS = 1_000;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * FIFO queue with a bounded, droppable log lane.  Control transitions (and
 * locally-generated log-loss notices) apply source backpressure instead of
 * being retained in an unbounded waiter list. Normal logs cannot overtake a
 * waiting control transition.
 */
export class WsOutboundBuffer {
  private readonly items: WsBufferItem[] = [];
  private readonly inflight = new Set<WsBufferItem>();
  /** Tickets preserve critical FIFO without retaining their message or a
   * callback in the buffer before capacity exists. */
  private nextAdmissionTicket = 0;
  private admissionTurn = 0;
  private capacity = capacitySignal();
  private closed = false;
  private bytes = 0;
  private readonly onDrop: (message: Extract<HostToServerMessage, { type: "session:log" }>) => void;

  constructor(
    onDrop: (message: Extract<HostToServerMessage, { type: "session:log" }>) => void = () => {},
  ) {
    this.onDrop = onDrop;
  }

  enqueue(message: HostToServerMessage, options: WsBufferOptions = {}): Promise<void> {
    if (this.closed) return Promise.reject(new Error("WebSocket transport closed"));
    const bytes = Buffer.byteLength(JSON.stringify(message));
    const nonDroppable = options.nonDroppable === true || message.type !== "session:log";
    if (bytes > MAX_BYTES) {
      if (!nonDroppable) this.drop(message);
      return Promise.reject(new Error("outbound frame exceeds buffer limit"));
    }
    // A waiting retained frame defines the next FIFO position. Logs produced
    // after it are intentionally droppable instead of overtaking it.
    if (!nonDroppable && (this.hasWaitingAdmission() || !this.makeRoom(bytes))) {
      this.drop(message);
      return Promise.reject(new Error(`outbound buffer full for ${message.type}`));
    }
    if (nonDroppable) return this.enqueueRetained(message, bytes, options);
    return this.enqueueAdmitted(message, bytes, nonDroppable, options);
  }

  private async enqueueRetained(
    message: HostToServerMessage,
    bytes: number,
    options: WsBufferOptions,
  ): Promise<void> {
    const ticket = this.nextAdmissionTicket++;
    while (true) {
      if (this.closed) throw new Error("WebSocket transport closed");
      if (ticket !== this.admissionTurn) {
        await this.capacity.promise;
        continue;
      }
      if (options.signal?.aborted) {
        this.admissionTurn++;
        this.notifyCapacity();
        throw new Error("outbound frame cancelled");
      }
      this.evictLogsUntilFits(bytes);
      if (!this.fits(bytes)) {
        await this.capacity.promise;
        continue;
      }
      this.admissionTurn++;
      const delivery = this.enqueueAdmitted(message, bytes, true, options);
      this.notifyCapacity();
      return delivery;
    }
  }

  private enqueueAdmitted(
    message: HostToServerMessage,
    bytes: number,
    nonDroppable: boolean,
    options: WsBufferOptions,
  ): Promise<void> {
    // Retained frames make room by evicting ordinary logs.  If the retained
    // lane is itself saturated we intentionally retain it: silently rejecting
    // an ack/status would strand server state. Producers observe backpressure
    // through the unresolved delivery promise until the socket recovers.
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const abort = () => {
        const index = this.items.indexOf(item);
        if (index >= 0) {
          this.items.splice(index, 1);
          this.bytes -= bytes;
          finishReject(new Error("outbound frame cancelled"));
          this.notifyCapacity();
        }
      };
      const finishResolve = () => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        resolve();
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      };
      const item: WsBufferItem = {
        message,
        bytes,
        nonDroppable,
        resolve: finishResolve,
        reject: finishReject,
        dispose: () => options.signal?.removeEventListener("abort", abort),
        cancelled: () => options.signal?.aborted === true,
      };
      if (options.signal?.aborted) {
        finishReject(new Error("outbound frame cancelled"));
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      this.admit(item);
      this.notifyCapacity();
    });
  }

  take(): WsBufferItem | undefined {
    const item = this.items.shift();
    if (item) this.inflight.add(item);
    return item;
  }

  putBack(item: WsBufferItem): void {
    this.inflight.delete(item);
    this.items.unshift(item);
  }

  /** Finalize a taken frame. Capacity is released only after its write is
   * known to have succeeded or been deliberately dropped. */
  complete(item: WsBufferItem): void {
    if (!this.inflight.delete(item)) return;
    this.bytes -= item.bytes;
    this.notifyCapacity();
  }

  get length(): number {
    return this.items.length + this.inflight.size;
  }

  rejectAll(error: Error): void {
    this.closed = true;
    for (const item of this.items.splice(0)) {
      item.dispose();
      item.reject(error);
    }
    for (const item of this.inflight) {
      item.dispose();
      item.reject(error);
    }
    this.inflight.clear();
    this.bytes = 0;
    this.notifyCapacity();
  }

  private makeRoom(bytes: number): boolean {
    return this.fits(bytes);
  }

  private evictLogsUntilFits(bytes: number): void {
    while (!this.fits(bytes)) {
      const index = this.items.findIndex(
        (item) => item.message.type === "session:log" && !item.nonDroppable,
      );
      if (index < 0) return;
      const [dropped] = this.items.splice(index, 1) as [WsBufferItem];
      this.bytes -= dropped.bytes;
      dropped.dispose();
      this.drop(dropped.message as Extract<HostToServerMessage, { type: "session:log" }>);
      dropped.reject(new Error("outbound log dropped while disconnected"));
    }
  }

  private admit(item: WsBufferItem): void {
    this.items.push(item);
    this.bytes += item.bytes;
  }

  private notifyCapacity(): void {
    const previous = this.capacity;
    this.capacity = capacitySignal();
    previous.resolve();
  }

  private hasWaitingAdmission(): boolean {
    return this.nextAdmissionTicket !== this.admissionTurn;
  }

  private drop(message: Extract<HostToServerMessage, { type: "session:log" }>): void {
    this.onDrop(message);
  }

  private fits(bytes: number): boolean {
    return this.length < MAX_ITEMS && this.bytes + bytes <= MAX_BYTES;
  }
}
