import { test } from "@playwright/test";

import { hasCli, runRealCliSession } from "./real-cli-helpers.ts";

/**
 * Real `cursor-agent --print` session, end to end through the browser. Deliberately never runs
 * in CI (no credentials there) — see the `real-cli` Playwright project, only registered when
 * `HARNESS_REAL_CLI` is set. Run locally with HARNESS_REAL_CLI=1.
 */
test.describe("real CLI: cursor", () => {
  test.skip(!hasCli("cursor-agent"), "cursor-agent CLI not installed");
  test.setTimeout(300_000);

  test("browser-created session runs cursor-agent and completes with a real reply", async ({
    page,
    request,
  }) => {
    await runRealCliSession({
      page,
      request,
      providerName: "cursor",
      argv: ["cursor-agent", "--print", "--force", "--output-format", "json"],
      appendPrompt: true,
      appendPromptSeparator: true,
      expectStdout: /hello world/i,
    });
  });
});
