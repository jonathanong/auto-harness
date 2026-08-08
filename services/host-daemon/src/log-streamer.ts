import { formatLogSortKey } from "@auto-harness/shared";
import type { LogStream, SessionLogChunk } from "@auto-harness/shared";

type LogEmit = (chunk: SessionLogChunk) => void;

/**
 * Buffers session log lines with a monotonic per-session sequence (Invariant 5).
 */
export class LogStreamer {
  private seq = 0;
  private readonly sessionId: string;
  private readonly emit: LogEmit;
  private readonly now: () => string;

  constructor(
    sessionId: string,
    emit: LogEmit,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.sessionId = sessionId;
    this.emit = emit;
    this.now = now;
  }

  nextSeq(): number {
    return this.seq;
  }

  write(stream: LogStream, content: string): SessionLogChunk {
    const timestamp = this.now();
    const seq = this.seq++;
    const chunk: SessionLogChunk = {
      sessionId: this.sessionId,
      stream,
      content,
      timestamp,
      seq,
    };
    this.emit(chunk);
    return chunk;
  }

  /** Sort key for DynamoDB SessionLogs SK. */
  sortKey(chunk: SessionLogChunk): string {
    return formatLogSortKey(chunk.timestamp, chunk.seq);
  }
}
