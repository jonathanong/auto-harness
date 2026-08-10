import { isValidCliResumeRef, type ResumeRefCapture } from "@auto-harness/shared";

const MAX_PENDING_LINE_BYTES = 4 * 1024;
const REDACTED_LINE = "[CLI resume reference redacted]";

function acceptsStream(policy: ResumeRefCapture, stream: "stdout" | "stderr"): boolean {
  return policy.stream === "either" || policy.stream === stream;
}

/** Incrementally extracts the latest bounded, literal-prefix resume reference. */
export class ResumeRefCaptureReader {
  private readonly pending = { stdout: "", stderr: "" };
  private readonly pendingOrder = { stdout: 0, stderr: 0 };
  private readonly trailing: Array<{ stream: "stdout" | "stderr"; content: string }> = [];
  private readonly policy: ResumeRefCapture | undefined;
  private captured: string | undefined;
  private capturedOrder = 0;
  private order = 0;

  constructor(policy: ResumeRefCapture | undefined) {
    this.policy = policy;
  }

  push(stream: "stdout" | "stderr", content: string): string {
    if (!this.policy || !acceptsStream(this.policy, stream)) return content;
    const order = ++this.order;
    this.pendingOrder[stream] = order;
    const lines = `${this.pending[stream]}${content}`.split(/\r\n|[\r\n]/u);
    this.pending[stream] = lines.pop()!;
    const output = lines.map((line) =>
      this.captureLine(line, order) ? `${REDACTED_LINE}\n` : `${line}\n`,
    );
    if (Buffer.byteLength(this.pending[stream], "utf8") > MAX_PENDING_LINE_BYTES) {
      output.push(this.pending[stream]);
      this.pending[stream] = "";
    }
    return output.join("");
  }

  finish(): string | undefined {
    if (this.policy) {
      const streams = (["stdout", "stderr"] as const)
        .filter((stream) => acceptsStream(this.policy!, stream))
        .toSorted((left, right) => this.pendingOrder[left] - this.pendingOrder[right]);
      for (const stream of streams) {
        const pending = this.pending[stream];
        if (!pending) continue;
        const redacted = this.captureLine(pending, this.pendingOrder[stream]);
        this.trailing.push({ stream, content: redacted ? REDACTED_LINE : pending });
        this.pending[stream] = "";
      }
    }
    return this.captured;
  }

  drainTrailing(): Array<{ stream: "stdout" | "stderr"; content: string }> {
    return this.trailing.splice(0);
  }

  private captureLine(line: string, order: number): boolean {
    if (!this.policy || !line.startsWith(this.policy.linePrefix)) return false;
    const value = line.slice(this.policy.linePrefix.length).trim();
    if (isValidCliResumeRef(value) && order >= this.capturedOrder) {
      this.captured = value;
      this.capturedOrder = order;
    }
    return true;
  }
}
