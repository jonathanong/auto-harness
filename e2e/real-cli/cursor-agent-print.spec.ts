import { test } from "@playwright/test";

import { cliRecipeByProvider } from "../../modules/shared/src/cli-recipes.ts";
import { hasCli, runRealCliSession } from "./real-cli-helpers.ts";

const recipe = cliRecipeByProvider("cursor-agent");
if (!recipe) throw new Error("missing cursor-agent recipe");

/**
 * Real `cursor-agent -p --trust` session. Never CI — see the `real-cli` Playwright
 * project. Run locally: `HARNESS_REAL_CLI=1 pnpm test:e2e:real-cli`.
 * Do not pass Cursor's `--worktree`; Auto Harness already owns cwd/worktrees.
 */
test.describe("real CLI: cursor-agent", () => {
  test.skip(!hasCli("cursor-agent"), "cursor-agent CLI not installed");
  test.setTimeout(300_000);

  test("browser-created session runs `cursor-agent -p --trust` and completes", async ({
    page,
    request,
  }) => {
    await runRealCliSession({
      page,
      request,
      providerName: recipe.providerName,
      argv: [...recipe.argv],
      appendPrompt: recipe.appendPrompt,
      expectStdout: /hello world/i,
    });
  });
});
