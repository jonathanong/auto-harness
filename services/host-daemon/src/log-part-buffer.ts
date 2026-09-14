import {
  concatGzipMembers,
  gzipJsonlLines,
  normalizeSessionLogSettings,
  type SessionLogChunk,
  type SessionLogSettings,
} from "@auto-harness/shared";

import { httpBaseFromApiUrl } from "./bootstrap.ts";

export type LogPartUpload = {
  apiUrl: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
};

export class LogPartBuffer {
  private readonly sessionId: string;
  private readonly settings: SessionLogSettings;
  private readonly upload: LogPartUpload | undefined;
  private readonly local: ((chunk: SessionLogChunk) => void) | undefined;
  private pending: SessionLogChunk[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly uploaded: Buffer[] = [];
  watching = false;

  constructor(
    sessionId: string,
    settings: SessionLogSettings | undefined,
    upload: LogPartUpload | undefined,
    local?: (chunk: SessionLogChunk) => void,
  ) {
    this.sessionId = sessionId;
    this.settings = normalizeSessionLogSettings(settings);
    this.upload = upload;
    this.local = local;
  }

  push(chunk: SessionLogChunk): void {
    this.local?.(chunk);
    if (!this.shouldUpload()) return;
    this.pending.push(chunk);
    this.pendingBytes += Buffer.byteLength(chunk.content, "utf8");
    if (
      this.pendingBytes >= this.settings.batchMaxKb * 1024 ||
      this.pending.length >= this.settings.batchMaxLines
    ) {
      void this.flush().catch(() => undefined);
      return;
    }
    this.timer ??= setTimeout(
      () => void this.flush().catch(() => undefined),
      this.settings.batchMaxWaitMs,
    );
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    if (batch.length === 0 || !this.upload) return;
    const seqs = batch.map((chunk) => chunk.seq);
    const gzipped = gzipJsonlLines(
      batch.map((chunk) =>
        JSON.stringify({
          timestamp: chunk.timestamp,
          stream: chunk.stream,
          content: chunk.content,
          seq: chunk.seq,
          ...(chunk.dropped !== undefined ? { dropped: chunk.dropped } : {}),
        }),
      ),
    );
    try {
      await this.put(
        `/api/v1/sessions/${encodeURIComponent(this.sessionId)}/log-parts?seqStart=${Math.min(...seqs)}&seqEnd=${Math.max(...seqs)}`,
        gzipped,
      );
      this.uploaded.push(gzipped);
    } catch (error) {
      this.pending = [...batch, ...this.pending];
      this.pendingBytes += batch.reduce(
        (total, chunk) => total + Buffer.byteLength(chunk.content, "utf8"),
        0,
      );
      throw error;
    }
  }

  async flushFinal(): Promise<void> {
    await this.flush();
    if (this.uploaded.length === 0 || !this.upload) return;
    await this.put(
      `/api/v1/sessions/${encodeURIComponent(this.sessionId)}/log-archive`,
      concatGzipMembers(this.uploaded),
    );
  }

  private async put(path: string, gzipped: Buffer): Promise<void> {
    if (!this.upload) return;
    const base = httpBaseFromApiUrl(this.upload.apiUrl);
    const headers: Record<string, string> = { "content-type": "application/gzip" };
    if (this.upload.apiKey) headers.authorization = `Bearer ${this.upload.apiKey}`;
    const response = await (this.upload.fetchFn ?? fetch)(`${base}${path}`, {
      method: "PUT",
      headers,
      body: new Uint8Array(gzipped),
    });
    if (!response.ok) throw new Error(`log part upload failed: ${response.status}`);
  }

  private shouldUpload(): boolean {
    if (this.settings.uploadMode === "off") return false;
    if (this.settings.uploadMode === "always") return true;
    return this.watching;
  }
}
