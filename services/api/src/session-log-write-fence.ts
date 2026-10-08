import type { ControlPlaneState } from "./control-plane-state.ts";

const SESSION_LOG_WRITE_CHECK_TIMEOUT_MS = 10_000;

/**
 * Fence a late host-side object upload against a session that retention has claimed or removed.
 * Storage fakes without the retention facade keep their existing in-memory test behavior.
 */
export async function assertSessionLogWritesAllowed(
  state: ControlPlaneState,
  sessionId: string,
): Promise<void> {
  const storage = state.storage;
  const getStore = storage?.getSessionRetentionStore;
  if (typeof getStore !== "function") return;

  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const session = await Promise.race([
      getStore.call(storage).getSession(sessionId),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("session log write fence check timed out")),
          SESSION_LOG_WRITE_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    if (Date.now() - startedAt > SESSION_LOG_WRITE_CHECK_TIMEOUT_MS) {
      throw new Error("session log write fence check timed out");
    }
    if (!session || session.retentionToken) {
      throw new Error("session log write refused for a missing or retained session");
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
