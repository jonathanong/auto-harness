/**
 * Operator management verification (SCRATCH proofs).
 * Drives real startLocalServer HTTP + startWebServer handlers.
 *
 * Usage: SCRATCH=/tmp/harness-manage-scratch pnpm local:manage-verify
 */
import { manageRepos } from "./manage-verify/repos.mts";
import { manageSchedules } from "./manage-verify/schedules.mts";
import { manageSessionsAgents } from "./manage-verify/sessions-agents.mts";
import { manageWeb } from "./manage-verify/web.mts";

const SCRATCH = process.env.SCRATCH ?? "/tmp/harness-manage-scratch";

async function main(): Promise<void> {
  await manageRepos(SCRATCH);
  await manageSchedules(SCRATCH);
  await manageSessionsAgents(SCRATCH);
  await manageWeb(SCRATCH);
}

await main();
