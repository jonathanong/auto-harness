import { test } from "@playwright/test";

import { hasCli } from "./real-cli-setup.ts";
import { runUsageLimitSession } from "./usage-limit-helpers.ts";

/**
 * Real, out-of-usage CLI sessions, end to end against the actual control plane (API only —
 * no browser needed to observe the outcome). Deliberately never runs in CI (no credentials
 * there, and this needs an account that is genuinely out of quota) — see the `real-cli`
 * Playwright project, only registered when `HARNESS_REAL_CLI` is set. Run locally:
 *
 *   HARNESS_REAL_CLI=1 HARNESS_REAL_CLI_EXHAUSTED=codex,grok \
 *     pnpm test:e2e:real-cli -- e2e/real-cli/usage-limit.spec.ts
 *
 * `HARNESS_REAL_CLI_EXHAUSTED` is a comma list naming which of `claude`, `codex`, `grok`
 * are currently out of usage and safe to run against for real — never opt in an account that
 * still has quota, since the whole point is to observe a real 402/429-shaped failure. cursor
 * is never included here: there is no usage-limit adapter for it (see docs/agent-clis.md's
 * "Usage limits" section), so a real cursor run could not detect anything.
 */
const exhausted = new Set(
  (process.env.HARNESS_REAL_CLI_EXHAUSTED ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);

for (const providerName of ["codex", "grok", "claude"] as const) {
  test.describe(`real CLI usage limit: ${providerName}`, () => {
    test.skip(
      !exhausted.has(providerName),
      `${providerName} not listed in HARNESS_REAL_CLI_EXHAUSTED`,
    );
    test.skip(!hasCli(providerName), `${providerName} CLI not installed`);
    test.setTimeout(300_000);

    test(`provider account cools down and the session completes via fallback`, async ({
      request,
    }) => {
      await runUsageLimitSession({ request, providerName });
    });
  });
}
