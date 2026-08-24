/* eslint-disable max-lines -- coalescing, rate, and drop telemetry share one pending batch. */
import { formatLogSortKey, MAX_SESSION_LOG_DROPPED } from "@auto-harness/shared";
import type { LogStream, SessionLogChunk } from "@auto-harness/shared";

import {
  appendToBatch,
  batchAtBound,
  canAppendToBatch,
  DEFAULT_LOG_BATCH_MAX_LINES,
  DEFAULT_LOG_BATCH_MAX_WAIT_MS,
  DEFAULT_LOG_MESSAGES_PER_SEC,
  DEFAULT_MAX_WIRE_BYTES,
  formatDroppedLogNotice,
  LogRateWindow,
  splitLogLines,
  splitUtf8,
  startBatch,
  truncateUtf8,
  type CoalesceBatch,
} from "./log-coalesce.ts";

type LogEmit = (chunk: SessionLogChunk) => void;
type EnqueueResult = { chunk: SessionLogChunk | null; diverted: boolean };

const DEFAULT_MAX_LOG_CHUNKS = 10_000;
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;

export type LogLimits = {
  maxChunks?: number;
  maxBytes?: number;
  maxWireBytes?: number;
  logBatchMaxLines?: number;
  logBatchMaxWaitMs?: number;
  maxMessagesPerSec?: number;
  maxDroppedPerNotice?: number;
};

export type LogStreamerTimers = {
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  nowMs?: () => number;
};

/**
 * Buffers session log lines with a monotonic per-session sequence (Invariant 5).
 * Consecutive stdout/stderr writes coalesce up to byte/line bounds and ~10 msg/s.
 */
export class LogStreamer {
  private seq = 0;
  private readonly sessionId: string;
  private readonly attemptId: string;
  private readonly emit: LogEmit;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly maxChunks: number;
  private readonly maxBytes: number;
  private readonly maxWireBytes: number;
  private readonly logBatchMaxLines: number;
  private readonly logBatchMaxWaitMs: number;
  private readonly maxDroppedPerNotice: number;
  private readonly rate: LogRateWindow;
  private emittedChunks = 0;
  private emittedBytes = 0;
  private pending: CoalesceBatch | null = null;
  private pendingSinceMs = 0;
  private overflow: CoalesceBatch | null = null;
  private overflowSinceMs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private droppedChunks = 0;
  private unsentDropped = 0;

  constructor(
    sessionId: string,
    attemptId: string,
    emit: LogEmit,
    now: () => string = () => new Date().toISOString(),
    initialSeq = 0,
    limits: LogLimits = {},
    timers: LogStreamerTimers = {},
  ) {
    this.sessionId = sessionId;
    this.attemptId = attemptId;
    this.emit = emit;
    this.now = now;
    this.nowMs = timers.nowMs ?? Date.now;
    this.setTimeoutFn = timers.setTimeout ?? setTimeout;
    this.clearTimeoutFn = timers.clearTimeout ?? clearTimeout;
    this.seq = initialSeq;
    this.maxChunks = limits.maxChunks ?? DEFAULT_MAX_LOG_CHUNKS;
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.maxWireBytes = limits.maxWireBytes ?? DEFAULT_MAX_WIRE_BYTES;
    this.logBatchMaxLines = limits.logBatchMaxLines ?? DEFAULT_LOG_BATCH_MAX_LINES;
    this.logBatchMaxWaitMs = limits.logBatchMaxWaitMs ?? DEFAULT_LOG_BATCH_MAX_WAIT_MS;
    this.maxDroppedPerNotice = Math.max(1, limits.maxDroppedPerNotice ?? MAX_SESSION_LOG_DROPPED);
    this.rate = new LogRateWindow(
      limits.maxMessagesPerSec ?? DEFAULT_LOG_MESSAGES_PER_SEC,
      this.nowMs,
    );
  }

  nextSeq(): number {
    return this.seq;
  }

  droppedCount(): number {
    return this.droppedChunks;
  }

  write(stream: LogStream, content: string): SessionLogChunk | null {
    return this.writeAt(stream, content, this.now());
  }

  writeTimestampedSystem(label: string): SessionLogChunk | null {
    const timestamp = this.now();
    return this.writeAt("system", `${label} at ${timestamp}`, timestamp);
  }

  /** Emit coalesced output and drop notices so a later status frame is not first. */
  flush(): void {
    this.flushPending(true);
  }

  sortKey(chunk: SessionLogChunk): string {
    return formatLogSortKey(chunk.timestamp, chunk.seq);
  }

  private writeAt(stream: LogStream, content: string, timestamp: string): SessionLogChunk | null {
    const force = stream === "system";
    let last: SessionLogChunk | null = force ? this.flushPending(true) : null;
    if (!force && this.emittedChunks >= this.maxChunks && !this.pending && !this.overflow) {
      return last;
    }
    const bounded = force ? content : truncateUtf8(content, this.remainingBytes());
    if (bounded.length === 0) return last;
    let allowPending = true;
    for (const wirePiece of splitUtf8(bounded, this.maxWireBytes)) {
      for (const piece of splitLogLines(wirePiece, this.logBatchMaxLines)) {
        const result = this.enqueuePiece(stream, piece, timestamp, force, allowPending);
        if (result.chunk) last = result.chunk;
        if (result.diverted) allowPending = false;
      }
    }
    if (!force) {
      const flushed = this.afterStdoutEnqueue();
      if (flushed) last = flushed;
    }
    return last;
  }

  private fits(batch: CoalesceBatch, stream: LogStream, piece: string): boolean {
    return canAppendToBatch(
      batch,
      stream,
      piece,
      Buffer.byteLength(piece, "utf8"),
      this.maxWireBytes,
      this.logBatchMaxLines,
    );
  }

  private enqueuePiece(
    stream: LogStream,
    piece: string,
    timestamp: string,
    force: boolean,
    allowPending: boolean,
  ): EnqueueResult {
    if (allowPending && !this.overflow && this.pending && this.fits(this.pending, stream, piece)) {
      appendToBatch(this.pending, piece);
      return { chunk: null, diverted: false };
    }
    if (allowPending && !this.pending) {
      return { chunk: this.startPending(stream, piece, timestamp, force), diverted: false };
    }
    let last: SessionLogChunk | null = null;
    if (this.pending) last = this.flushPending(force);
    this.promoteOverflow();
    if (!this.pending) {
      return { chunk: this.startPending(stream, piece, timestamp, force) ?? last, diverted: false };
    }
    if (this.overflow && this.fits(this.overflow, stream, piece)) {
      appendToBatch(this.overflow, piece);
      return { chunk: last, diverted: true };
    }
    if (!this.overflow && this.emittedChunks + 1 < this.maxChunks) {
      this.overflow = startBatch(stream, piece, timestamp);
      this.overflowSinceMs = this.nowMs();
      return { chunk: last, diverted: true };
    }
    this.recordDrop();
    return { chunk: last, diverted: true };
  }

  private startPending(
    stream: LogStream,
    piece: string,
    timestamp: string,
    force: boolean,
  ): SessionLogChunk | null {
    if (!force && this.emittedChunks >= this.maxChunks) return null;
    this.pending = startBatch(stream, piece, timestamp);
    this.pendingSinceMs = this.nowMs();
    return force ? this.flushPending(true) : null;
  }

  private afterStdoutEnqueue(): SessionLogChunk | null {
    this.promoteOverflow();
    if (!this.pending) return this.flushDropNotice(false);
    if (
      this.logBatchMaxWaitMs === 0 ||
      this.overflow !== null ||
      this.unsentDropped >= this.maxDroppedPerNotice ||
      batchAtBound(this.pending, this.maxWireBytes, this.logBatchMaxLines)
    ) {
      return this.flushPending(false);
    }
    this.scheduleFlush();
    return null;
  }

  private remainingBytes(): number {
    return (
      this.maxBytes - this.emittedBytes - (this.pending?.bytes ?? 0) - (this.overflow?.bytes ?? 0)
    );
  }

  private promoteOverflow(): void {
    if (this.pending || !this.overflow) return;
    this.pending = this.overflow;
    this.pendingSinceMs = this.overflowSinceMs;
    this.overflow = null;
  }

  private flushPending(force: boolean): SessionLogChunk | null {
    let last: SessionLogChunk | null = null;
    this.promoteOverflow();
    while (this.pending) {
      if (!force && !this.rate.canEmit()) {
        this.scheduleFlush();
        return last;
      }
      this.clearTimer();
      const batch = this.pending;
      this.pending = null;
      last = this.emitChunk(batch.stream, batch.content, batch.timestamp);
      this.promoteOverflow();
      if (!force) break;
    }
    const notice = this.flushDropNotice(force);
    if (!force && (this.pending || this.overflow || this.unsentDropped > 0)) this.scheduleFlush();
    return notice ?? last;
  }

  private flushDropNotice(force: boolean): SessionLogChunk | null {
    let last: SessionLogChunk | null = null;
    while (this.unsentDropped > 0) {
      const mustSend =
        force ||
        (this.unsentDropped >= this.maxDroppedPerNotice && !this.pending && !this.overflow);
      if (!mustSend && last) {
        this.scheduleFlush();
        return last;
      }
      if (!mustSend && !this.rate.canEmit()) {
        this.scheduleFlush();
        return last;
      }
      const count = Math.min(this.unsentDropped, this.maxDroppedPerNotice);
      this.unsentDropped -= count;
      last = this.emitRaw("system", formatDroppedLogNotice(count), this.now(), count);
    }
    return last;
  }

  private recordDrop(): void {
    this.droppedChunks += 1;
    this.unsentDropped += 1;
  }

  private emitChunk(stream: LogStream, content: string, timestamp: string): SessionLogChunk {
    return this.emitRaw(stream, content, timestamp);
  }

  private emitRaw(
    stream: LogStream,
    content: string,
    timestamp: string,
    dropped?: number,
  ): SessionLogChunk {
    const seq = this.seq++;
    const chunk: SessionLogChunk = {
      sessionId: this.sessionId,
      attemptId: this.attemptId,
      stream,
      content,
      timestamp,
      seq,
      ...(dropped !== undefined ? { dropped } : {}),
    };
    this.emittedChunks += 1;
    this.emittedBytes += Buffer.byteLength(content, "utf8");
    this.rate.record();
    this.emit(chunk);
    return chunk;
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined || (!this.pending && !this.overflow && this.unsentDropped === 0)) {
      return;
    }
    const now = this.nowMs();
    const waitForCoalesce =
      this.pending &&
      !this.overflow &&
      this.unsentDropped < this.maxDroppedPerNotice &&
      !batchAtBound(this.pending, this.maxWireBytes, this.logBatchMaxLines);
    const due = Math.max(
      waitForCoalesce ? this.pendingSinceMs + this.logBatchMaxWaitMs : now,
      this.rate.nextEmitAt(now),
    );
    this.timer = this.setTimeoutFn(
      () => {
        this.timer = undefined;
        this.flushPending(false);
      },
      Math.max(0, due - now),
    );
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimeoutFn(this.timer);
    this.timer = undefined;
  }
}
