import { formatLogSortKey } from "@auto-harness/shared";
import type { LogStream, SessionLogChunk } from "@auto-harness/shared";

type LogEmit = (chunk: SessionLogChunk) => void;

const DEFAULT_MAX_LOG_CHUNKS = 10_000;
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;

// API Gateway's WebSocket limit is 128 KB per *message*, but only 32 KB per *frame* — a
// message over 32 KB must be split into multiple frames, and the `ws` client this daemon
// uses (ws-transport.ts) sends every outbound payload as a single frame with no built-in
// fragmentation (send()'s `fin` option defaults to true). So the real hard limit for one
// `ws.send()` call is 32 KB, not 128 KB — deployed against AWS, exceeding it closes the
// socket with code 1009. The local `ws` server has no such limit, so this was previously
// invisible outside a real deploy.
const API_GATEWAY_MAX_FRAME_BYTES = 32 * 1024;
// Headroom for the session:log envelope around `content` — type, sessionId, stream,
// timestamp, seq — none of which can contain adversarial bytes (see splitUtf8's caller).
const ENVELOPE_OVERHEAD_BYTES = 512;
// JSON.stringify's worst case for one raw byte with no short escape (an unprintable
// control byte) is a six-ASCII-byte unicode escape sequence. Log content is arbitrary
// CLI/terminal output, so this bounds the *raw* content budget against that worst case,
// not just typical ANSI-escape-heavy output (about 2x expansion in practice).
const JSON_ESCAPE_WORST_CASE_FACTOR = 6;
const DEFAULT_MAX_WIRE_BYTES = Math.floor(
  (API_GATEWAY_MAX_FRAME_BYTES - ENVELOPE_OVERHEAD_BYTES) / JSON_ESCAPE_WORST_CASE_FACTOR,
);

type LogLimits = {
  maxChunks?: number;
  maxBytes?: number;
  maxWireBytes?: number;
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
 * Split content into UTF-8-safe pieces no larger than maxBytesPerPiece each. Unlike
 * truncateUtf8, this covers the whole string — nothing is dropped, only split at char
 * boundaries. A single character wider than maxBytesPerPiece still forms its own (slightly
 * over-budget) piece rather than being dropped or looping forever.
 */
function splitUtf8(content: string, maxBytesPerPiece: number): string[] {
  // No explicit empty-string guard: the only caller (writeAt) already returns before this
  // point when its bounded content is empty, and an empty for-of loop naturally yields [].
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
  private readonly maxWireBytes: number;
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
    this.maxWireBytes = limits.maxWireBytes ?? DEFAULT_MAX_WIRE_BYTES;
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
    // A single write() call can still exceed the wire limit, so it may emit more than one
    // chunk here — each takes its own seq, preserving the monotonic sequence invariant.
    // Callers don't use the return value; it's the last chunk emitted, or null if the
    // per-session budget was already exhausted before this call could emit anything.
    let last: SessionLogChunk | null = null;
    for (const piece of splitUtf8(bounded, this.maxWireBytes)) {
      if (this.emittedChunks >= this.maxChunks) break;
      const seq = this.seq++;
      const chunk: SessionLogChunk = {
        sessionId: this.sessionId,
        stream,
        content: piece,
        timestamp,
        seq,
      };
      this.emittedChunks += 1;
      this.emittedBytes += Buffer.byteLength(piece, "utf8");
      this.emit(chunk);
      last = chunk;
    }
    return last;
  }

  /** Sort key for DynamoDB SessionLogs SK. */
  sortKey(chunk: SessionLogChunk): string {
    return formatLogSortKey(chunk.timestamp, chunk.seq);
  }
}
