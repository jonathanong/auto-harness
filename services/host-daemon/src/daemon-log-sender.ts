import type { SessionLogChunk } from "@auto-harness/shared";

import { OutboundQueue } from "./outbound-queue.ts";

export async function sendDaemonLog(
  outbound: OutboundQueue,
  onLog: ((line: string) => void) | undefined,
  chunk: SessionLogChunk,
): Promise<void> {
  onLog?.(`[${chunk.stream}#${chunk.seq}] ${chunk.content}`);
  await outbound
    .send({
      type: "session:log",
      sessionId: chunk.sessionId,
      stream: chunk.stream,
      content: chunk.content,
      timestamp: chunk.timestamp,
      seq: chunk.seq,
    })
    .catch((err: unknown) => {
      onLog?.(`log delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}
