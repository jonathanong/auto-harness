import { rmSync } from "node:fs";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { encodeSessionTargetOptionValue } from "../../services/web/src/session-target.ts";
import {
  API,
  REAL_CLI_PROMPT,
  createCatalogProviderAndCommand,
  enableSessionLogUploadAlways,
  hasCli,
  setupRealCliRepo,
} from "./real-cli-setup.ts";
import {
  attachRealCliHostInventory,
  createProviderAccount,
  startRealCliDaemon,
} from "./real-cli-setup-host.ts";

export { hasCli };

/**
 * Full real-CLI orchestration flow, shared by claude/codex/grok specs:
 * real temp git repo, real in-process agent daemon (real WS, real subprocess), real
 * browser-driven session creation against a real Provider/Command/ProviderAccount, poll to
 * completion, assert the real CLI's stdout. Mirrors e2e/control/orchestration.spec.ts's
 * shape, but with a real AI CLI instead of `echo` and a case-insensitive substring match
 * (model output varies) instead of an exact line match.
 *
 * Provider-targeted sessions stay queued unless the daemon advertises that account ready
 * via `HARNESS_EXECUTION_PROFILES`. Transcript bodies only appear on GET /logs when upload
 * is on (default is off).
 */
export async function runRealCliSession(opts: {
  page: Page;
  request: APIRequestContext;
  providerName: string;
  argv: string[];
  appendPrompt: boolean;
  appendPromptSeparator?: boolean;
  expectStdout: RegExp;
}): Promise<void> {
  const { page, request, providerName, argv, appendPrompt, expectStdout } = opts;
  const appendPromptSeparator = opts.appendPromptSeparator ?? true;
  // Provider and command names are unique, and an isolated e2e stack keeps its DynamoDB
  // container across runs, so a fixed `claude` name would fail every run after the first.
  const catalogName = `${providerName}-${Date.now()}`;
  let stopDaemon: (() => Promise<void>) | undefined;
  const { root, repo, wt, hostId, repoId, wtId } = await setupRealCliRepo(providerName);

  try {
    const { provider } = await createCatalogProviderAndCommand(request, {
      catalogName,
      argv,
      appendPrompt,
      appendPromptSeparator,
    });

    await enableSessionLogUploadAlways(request);

    const account = await createProviderAccount(request, { providerId: provider.id, label: "e2e" });

    const { repositoryId } = await attachRealCliHostInventory(request, {
      hostId,
      repoId,
      repoPath: repo,
      wtId,
      wtPath: wt,
      labels: [providerName],
      providerAccountIds: [account.id],
    });

    stopDaemon = (await startRealCliDaemon({ hostId, root, providerAccountIds: [account.id] }))
      .stop;

    await page.goto("/sessions/new");
    await expect(page.getByTestId("create-session-target")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("create-session-repository-id").selectOption(repositoryId);
    // Select by value, not label: a provider option's label is only the provider's name, which
    // does not identify it once earlier runs have left other providers behind.
    await page
      .getByTestId("create-session-target")
      .selectOption(encodeSessionTargetOptionValue({ kind: "provider", id: provider.id }));
    await page.getByTestId("create-session-prompt").fill(REAL_CLI_PROMPT);
    await page.getByTestId("create-session-timeout").selectOption("custom");
    await page.getByTestId("create-session-timeout-custom").fill("240");
    await page.getByTestId("create-session-submit").click();

    await expect(page.getByTestId("page-session-detail")).toBeVisible({ timeout: 15_000 });
    const sessionId = await page.getByTestId("session-detail-id").innerText();

    // Local dev/test never auto-assigns — nudge the scheduler, same as every other real-daemon
    // spec here. Real CLI turns take real wall-clock time, so poll far longer than the echo case.
    let status = "queued";
    for (let i = 0; i < 240 && status !== "completed" && status !== "failed"; i++) {
      await request.post(`${API}/api/v1/scheduler/assign`);
      await new Promise((r) => setTimeout(r, 1_000));
      const res = await request.get(`${API}/api/v1/sessions/${sessionId}`);
      status = ((await res.json()) as { status: string }).status;
    }
    expect(status).toBe("completed");

    await page.reload();
    await expect(page.getByTestId("session-detail-status")).toContainText("completed");

    const logsRes = await request.get(`${API}/api/v1/sessions/${sessionId}/logs`);
    const { items } = (await logsRes.json()) as {
      items: Array<{ stream: string; content: string }>;
    };
    const stdout = items
      .filter((l) => l.stream === "stdout")
      .map((l) => l.content)
      .join("\n");
    expect(stdout).toMatch(expectStdout);
  } finally {
    await stopDaemon?.();
    rmSync(root, { recursive: true, force: true });
  }
}
