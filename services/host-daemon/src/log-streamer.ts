import { formatLogSortKey } from "@auto-harness/shared";
import type { LogStream, SessionLogChunk } from "@auto-harness/shared";

type LogEmit = (chunk: SessionLogChunk) => void;

const DEFAULT_MAX_LOG_CHUNKS = 10_000;
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;

type LogLimits = {
  maxChunks?: number;
  maxBytes?: number;
};

function truncateUtf8(content: string, maxBytes: number): string {
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

/**
 * Buffers session log lines with a monotonic per-session sequence (Invariant 5).
 */
export class LogStreamer {
  private seq = 0;
  private readonly sessionId: string;
  private readonly emit: LogEmit;
  private readonly now: () => string;
  private readonly maxChunks: number;
  private readonly maxBytes: number;
  private emittedChunks = 0;
  private emittedBytes = 0;

  constructor(
    sessionId: string,
    emit: LogEmit,
    now: () => string = () => new Date().toISOString(),
    initialSeq = 0,
    limits: LogLimits = {},
  ) {
    this.sessionId = sessionId;
    this.emit = emit;
    this.now = now;
    this.seq = initialSeq;
    this.maxChunks = limits.maxChunks ?? DEFAULT_MAX_LOG_CHUNKS;
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  }

  nextSeq(): number {
    return this.seq;
  }

  write(stream: LogStream, content: string): SessionLogChunk | null {
    return this.writeAt(stream, content, this.now());
  }

  writeTimestampedSystem(label: string): SessionLogChunk | null {
    const timestamp = this.now();
    return this.writeAt("system", `${label} at ${timestamp}`, timestamp);
  }

  private writeAt(stream: LogStream, content: string, timestamp: string): SessionLogChunk | null {
    if (this.emittedChunks >= this.maxChunks || this.emittedBytes >= this.maxBytes) {
      return null;
    }
    const bounded = truncateUtf8(content, this.maxBytes - this.emittedBytes);
    if (bounded.length === 0) return null;
    const seq = this.seq++;
    const chunk: SessionLogChunk = {
      sessionId: this.sessionId,
      stream,
      content: bounded,
      timestamp,
      seq,
    };
    this.emittedChunks += 1;
    this.emittedBytes += Buffer.byteLength(bounded, "utf8");
    this.emit(chunk);
    return chunk;
  }

  /** Sort key for DynamoDB SessionLogs SK. */
  sortKey(chunk: SessionLogChunk): string {
    return formatLogSortKey(chunk.timestamp, chunk.seq);
  }
}
