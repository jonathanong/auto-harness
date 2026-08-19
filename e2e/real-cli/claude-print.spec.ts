import { test } from "@playwright/test";

import { hasCli, runRealCliSession } from "./real-cli-helpers.ts";

/**
 * Real `claude -p` session, end to end through the browser. Deliberately never runs in CI
 * (no credentials there) — see the `real-cli` Playwright project, only registered when
 * `HARNESS_REAL_CLI` is set. Run locally: `HARNESS_REAL_CLI=1 pnpm test:e2e:real-cli`.
 */
test.describe("real CLI: claude", () => {
  test.skip(!hasCli("claude"), "claude CLI not installed");
  test.setTimeout(300_000);

  test("browser-created session runs `claude -p` and completes with a real reply", async ({
    page,
    request,
  }) => {
    // Empirically verified (see docs/host-daemon-e2e-testing.md §5.2): no extra flags needed,
    // exit 0, prints exactly the reply with no banner noise around it.
    await runRealCliSession({
      page,
      request,
      providerName: "claude",
      argv: ["claude", "-p"],
      appendPrompt: true,
      expectStdout: /hello world/i,
    });
  });
});
