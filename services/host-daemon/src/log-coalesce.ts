import type { LogStream } from "@auto-harness/shared";

/** Approximate source-side `session:log` rate (docs/host-daemon.md). */
export const DEFAULT_LOG_MESSAGES_PER_SEC = 10;
/** Flush a coalesced batch at least this often so the rate stays near 10 msg/s. */
export const DEFAULT_LOG_BATCH_MAX_WAIT_MS = 100;
/** Newline-delimited lines allowed in one coalesced frame. */
export const DEFAULT_LOG_BATCH_MAX_LINES = 100;
const RATE_WINDOW_MS = 1_000;

// API Gateway's WebSocket limit is 128 KB per *message*, but only 32 KB per *frame*.
// The daemon `ws` client sends every payload as a single frame (`fin` defaults true),
// so the hard limit for one `ws.send()` is 32 KB — over it, AWS closes with 1009.
const API_GATEWAY_MAX_FRAME_BYTES = 32 * 1024;
const ENVELOPE_OVERHEAD_BYTES = 512;
const JSON_ESCAPE_WORST_CASE_FACTOR = 6;
export const DEFAULT_MAX_WIRE_BYTES = Math.floor(
  (API_GATEWAY_MAX_FRAME_BYTES - ENVELOPE_OVERHEAD_BYTES) / JSON_ESCAPE_WORST_CASE_FACTOR,
);

export type CoalesceBatch = {
  stream: LogStream;
  content: string;
  timestamp: string;
  bytes: number;
};

export function countLogLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  return content.charCodeAt(content.length - 1) === 10 ? lines : lines + 1;
}

export function formatDroppedLogNotice(dropped: number): string {
  return `${dropped} log chunk(s) dropped`;
}

export function truncateUtf8(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  let used = 0;
  let result = "";
  for (const char of content) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    result += char;
    used += size;
  }
  return result;
}

/** Split on UTF-8 char boundaries. A single over-budget character stays intact. */
export function splitUtf8(content: string, maxBytesPerPiece: number): string[] {
  const pieces: string[] = [];
  let current = "";
  let used = 0;
  for (const char of content) {
    const size = Buffer.byteLength(char, "utf8");
    if (used > 0 && used + size > maxBytesPerPiece) {
      pieces.push(current);
      current = "";
      used = 0;
    }
    current += char;
    used += size;
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

export function canAppendToBatch(
  batch: CoalesceBatch,
  stream: LogStream,
  piece: string,
  pieceBytes: number,
  maxBytes: number,
  maxLines: number,
): boolean {
  if (batch.stream !== stream) return false;
  if (batch.bytes + pieceBytes > maxBytes) return false;
  return countLogLines(batch.content + piece) <= maxLines;
}

/** True when one more byte/line would exceed the coalesce bounds. */
export function batchAtBound(batch: CoalesceBatch, maxBytes: number, maxLines: number): boolean {
  return !canAppendToBatch(batch, batch.stream, "\n", 1, maxBytes, maxLines);
}

/** Split so each piece has at most `maxLines` newline-delimited lines. */
export function splitLogLines(content: string, maxLines: number): string[] {
  if (content.length === 0) return [];
  if (countLogLines(content) <= maxLines) return [content];
  const pieces: string[] = [];
  let current = "";
  let lines = 0;
  for (const char of content) {
    current += char;
    if (char === "\n") {
      lines += 1;
      if (lines >= maxLines) {
        pieces.push(current);
        current = "";
        lines = 0;
      }
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

export function startBatch(stream: LogStream, content: string, timestamp: string): CoalesceBatch {
  return { stream, content, timestamp, bytes: Buffer.byteLength(content, "utf8") };
}

export function appendToBatch(batch: CoalesceBatch, piece: string): void {
  batch.content += piece;
  batch.bytes += Buffer.byteLength(piece, "utf8");
}

export class LogRateWindow {
  private readonly times: number[] = [];
  private readonly maxMessagesPerSec: number;
  private readonly nowMs: () => number;

  constructor(maxMessagesPerSec: number, nowMs: () => number) {
    this.maxMessagesPerSec = maxMessagesPerSec;
    this.nowMs = nowMs;
  }

  canEmit(): boolean {
    if (!Number.isFinite(this.maxMessagesPerSec)) return true;
    this.prune();
    return this.times.length < this.maxMessagesPerSec;
  }

  nextEmitAt(now: number): number {
    if (!Number.isFinite(this.maxMessagesPerSec)) return now;
    this.prune();
    if (this.times.length < this.maxMessagesPerSec) return now;
    return this.times[0]! + RATE_WINDOW_MS;
  }

  record(): void {
    if (!Number.isFinite(this.maxMessagesPerSec)) return;
    this.times.push(this.nowMs());
  }

  private prune(): void {
    const cutoff = this.nowMs() - RATE_WINDOW_MS;
    while (this.times.length > 0 && this.times[0]! <= cutoff) this.times.shift();
  }
}
