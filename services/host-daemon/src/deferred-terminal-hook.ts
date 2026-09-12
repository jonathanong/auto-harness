import type { SessionRunResult } from "./session-outcome.ts";

/** Keep the checkout claim until the v4 retry disposition settles its retained hook. */
export function retainClaimForDeferredTerminalHook(
  result: SessionRunResult & { settleDeferredTerminalHook: (runHook: boolean) => Promise<void> },
  release: () => void,
): SessionRunResult {
  let settled = false;
  return {
    ...result,
    settleDeferredTerminalHook: async (runHook) => {
      if (settled) return;
      settled = true;
      try {
        await result.settleDeferredTerminalHook(runHook);
      } finally {
        release();
      }
    },
  };
}
