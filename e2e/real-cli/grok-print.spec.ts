import { test } from "@playwright/test";

import { hasCli, runRealCliSession } from "./real-cli-helpers.ts";

/**
 * Real `grok -p` session, end to end through the browser. Deliberately never runs in CI
 * (no credentials there) — see the `real-cli` Playwright project, only registered when
 * `HARNESS_REAL_CLI` is set. Run locally: `HARNESS_REAL_CLI=1 pnpm test:e2e:real-cli`.
 */
test.describe("real CLI: grok", () => {
  test.skip(!hasCli("grok"), "grok CLI not installed");
  test.setTimeout(300_000);

  test("browser-created session runs `grok -p` and completes with a real reply", async ({
    page,
    request,
  }) => {
    await runRealCliSession({
      page,
      request,
      providerName: "grok",
      argv: ["grok", "--always-approve", "--max-turns", "3", "--output-format", "json", "-p"],
      appendPrompt: true,
      appendPromptSeparator: false,
      expectStdout: /hello world/i,
    });
  });
});
