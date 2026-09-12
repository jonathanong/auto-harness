import type { OutputChunk, ProcessResult, ProcessRunner, RunProcessOptions } from "./executor.ts";

/** Redacts one exact secret before any command output reaches durable session logging. */
export class SecretRedactingProcessRunner implements ProcessRunner {
  readonly outputStreams?: "merged";

  constructor(
    private readonly inner: ProcessRunner,
    private readonly secret: string,
  ) {
    if (inner.outputStreams === "merged") this.outputStreams = "merged";
  }

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    const pending: Record<OutputChunk["stream"], string> = { stdout: "", stderr: "" };
    const forward = (stream: OutputChunk["stream"], finished: boolean) => {
      const value = pending[stream];
      let cursor = 0;
      let emitted = "";
      while (true) {
        const occurrence = value.indexOf(this.secret, cursor);
        if (occurrence === -1) break;
        emitted += `${value.slice(cursor, occurrence)}[redacted]`;
        cursor = occurrence + this.secret.length;
      }
      const remaining = value.slice(cursor);
      const suffixLength = finished ? 0 : this.pendingPrefixLength(remaining);
      emitted += remaining.slice(0, remaining.length - suffixLength);
      pending[stream] = remaining.slice(remaining.length - suffixLength);
      if (emitted) options.onChunk({ stream, data: emitted });
    };
    try {
      return await this.inner.run({
        ...options,
        onChunk: (chunk) => {
          pending[chunk.stream] += chunk.data;
          forward(chunk.stream, false);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line preserve-caught-error -- the original cause can contain the token.
      throw new Error(message.replaceAll(this.secret, "[redacted]"));
    } finally {
      forward("stdout", true);
      forward("stderr", true);
    }
  }

  /** Longest unmatched suffix that could become the beginning of the next secret. */
  private pendingPrefixLength(value: string): number {
    for (let length = Math.min(this.secret.length - 1, value.length); length > 0; length -= 1) {
      if (value.endsWith(this.secret.slice(0, length))) return length;
    }
    return 0;
  }
}
