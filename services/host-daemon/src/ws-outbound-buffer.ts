/* eslint-disable max-lines */
import type { HostToServerMessage } from "@auto-harness/shared";

type WsBufferOptions = {
  /** A recovery notice is a log on the wire, but must survive subsequent
   * pressure just like a protocol transition. */
  nonDroppable?: boolean;
  signal?: AbortSignal;
  onStart?: () => void;
};

type CapacitySignal = { promise: Promise<void>; resolve: () => void };

function capacitySignal(): CapacitySignal {
  // The Promise executor runs synchronously, so `resolve` is always assigned
  // by the time the constructor returns below.
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export type WsBufferItem = {
  message: HostToServerMessage;
  bytes: number;
  nonDroppable: boolean;
  delivery: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  dispose: () => void;
  cancelled: () => boolean;
  onStart: (() => void) | undefined;
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
  private readonly cancelledTickets = new Set<number>();
  private capacity = capacitySignal();
  private closed = false;
  private bytes = 0;
  private readonly onDrop: (message: Extract<HostToServerMessage, { type: "session:log" }>) => void;
  private readonly onAdmit: () => void;

  constructor(
    onDrop: (message: Extract<HostToServerMessage, { type: "session:log" }>) => void = () => {},
    onAdmit: () => void = () => {},
  ) {
    this.onDrop = onDrop;
    this.onAdmit = onAdmit;
  }

  enqueue(message: HostToServerMessage, options: WsBufferOptions = {}): Promise<void> {
    if (this.closed) return Promise.reject(new Error("WebSocket transport closed"));
    const bytes = Buffer.byteLength(JSON.stringify(message));
    const nonDroppable = options.nonDroppable === true || message.type !== "session:log";
    if (bytes > MAX_BYTES) {
      if (!nonDroppable) this.drop(message);
      return Promise.reject(new Error("outbound frame exceeds buffer limit"));
    }
    const coalesced = this.coalesceQueuedKeepalive(message, bytes);
    if (coalesced) return coalesced;
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
      if (options.signal?.aborted) {
        this.cancelledTickets.add(ticket);
        if (ticket === this.admissionTurn) this.advanceAdmissionTurn();
        this.notifyCapacity();
        throw new Error("outbound frame cancelled");
      }
      if (ticket !== this.admissionTurn) {
        await this.waitForCapacity(options.signal);
        continue;
      }
      this.evictLogsUntilFits(bytes);
      if (!this.fits(bytes)) {
        await this.waitForCapacity(options.signal);
        continue;
      }
      this.advanceAdmissionTurn();
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
    // The Promise executor below runs synchronously, so `item` is always
    // assigned by the time it's read after the constructor returns.
    let item!: WsBufferItem;
    const delivery = new Promise<void>((resolve, reject) => {
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
      item = {
        message,
        bytes,
        nonDroppable,
        delivery: undefined as never,
        resolve: finishResolve,
        reject: finishReject,
        dispose: () => options.signal?.removeEventListener("abort", abort),
        cancelled: () => options.signal?.aborted === true,
        onStart: options.onStart,
      };
      if (options.signal?.aborted) {
        finishReject(new Error("outbound frame cancelled"));
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      this.admit(item);
      this.notifyCapacity();
    });
    item.delivery = delivery;
    return delivery;
  }

  take(): WsBufferItem | undefined {
    const item = this.items.shift();
    if (item) {
      this.inflight.add(item);
      item.onStart?.();
    }
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
    this.onAdmit();
  }

  private notifyCapacity(): void {
    const previous = this.capacity;
    this.capacity = capacitySignal();
    previous.resolve();
  }

  private hasWaitingAdmission(): boolean {
    return this.nextAdmissionTicket !== this.admissionTurn;
  }

  private coalesceQueuedKeepalive(
    message: HostToServerMessage,
    bytes: number,
  ): Promise<void> | undefined {
    if (message.type !== "host:keepalive") return undefined;
    // An in-flight frame may already be serialized by ws. Keep the newer
    // timestamp as a distinct queued frame instead of mutating that write.
    const existing = this.items.find((item) => item.message.type === "host:keepalive");
    if (!existing || this.bytes - existing.bytes + bytes > MAX_BYTES) return undefined;
    this.bytes = this.bytes - existing.bytes + bytes;
    existing.bytes = bytes;
    existing.message = message;
    this.notifyCapacity();
    return existing.delivery;
  }

  private waitForCapacity(signal: AbortSignal | undefined): Promise<void> {
    const capacity = this.capacity.promise;
    if (!signal) return capacity;
    return new Promise<void>((resolve) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", wake);
        resolve();
      };
      signal.addEventListener("abort", wake, { once: true });
      void capacity.then(wake);
    });
  }

  private advanceAdmissionTurn(): void {
    this.admissionTurn++;
    while (this.cancelledTickets.delete(this.admissionTurn)) this.admissionTurn++;
  }

  private drop(message: Extract<HostToServerMessage, { type: "session:log" }>): void {
    this.onDrop(message);
  }

  private fits(bytes: number): boolean {
    return this.length < MAX_ITEMS && this.bytes + bytes <= MAX_BYTES;
  }
}
