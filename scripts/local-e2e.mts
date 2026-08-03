/**
 * Phase 1 local end-to-end path (no AWS):
 * 1) temp git repo + feature branch
 * 2) agent config with echo-prompt profile
 * 3) optional local API create
 * 4) SessionRunner run with ref checkout
 *
 * Exit 0 only if session completes and HEAD matches the session ref.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertUnknownProfileFails, createSessionViaApi, runHappyPath } from "./local-e2e/run.mts";
import { buildAgentConfig, buildPaths, initFeatureRepo } from "./local-e2e/setup.mts";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ah-local-e2e-"));
  const paths = buildPaths(root);

  try {
    const featureSha = await initFeatureRepo(paths);
    const config = buildAgentConfig(paths);

    // --- API create (documented local path) ---
    const created = await createSessionViaApi();

    // Unknown profile fails without shell
    await assertUnknownProfileFails(config);

    // Happy path: run session on feature ref
    await runHappyPath(config, paths, created, featureSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
