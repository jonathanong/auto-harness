import { test } from "@playwright/test";

import { hasCli, runRealCliSession } from "./real-cli-helpers.ts";

/**
 * Real `codex exec` session, end to end through the browser. Deliberately never runs in CI
 * (no credentials there) — see the `real-cli` Playwright project, only registered when
 * `HARNESS_REAL_CLI` is set. Run locally: `HARNESS_REAL_CLI=1 pnpm test:e2e:real-cli`.
 */
test.describe("real CLI: codex", () => {
  test.skip(!hasCli("codex"), "codex CLI not installed");
  test.setTimeout(300_000);

  test("browser-created session runs `codex exec` and completes with a real reply", async ({
    page,
    request,
  }) => {
    // Empirically verified (see docs/agent-e2e-testing.md §5.2): no sandbox/approval flag
    // needed for a reply-only prompt; stdout includes codex's own session banner/token
    // count around the reply, hence the substring match in expectStdout rather than exact.
    await runRealCliSession({
      page,
      request,
      providerName: "codex",
      argv: ["codex", "exec"],
      appendPrompt: true,
      expectStdout: /hello world/i,
    });
  });
});
