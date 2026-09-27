import { runClaimedSession } from "../src/session-run-claimed.ts";

/** Existing execution fixtures explicitly authorize the trusted command boundary. */
export function runAuthorizedClaimedSession(
  ...args: Parameters<typeof runClaimedSession>
): ReturnType<typeof runClaimedSession> {
  args[16] ??= async () => true;
  return runClaimedSession(...args);
}
