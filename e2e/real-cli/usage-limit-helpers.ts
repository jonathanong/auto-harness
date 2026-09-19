import { rmSync } from "node:fs";
import { expect, type APIRequestContext } from "@playwright/test";

import { catalogCommandDefaults } from "../../services/web/src/lib/catalog-command-defaults.ts";
import {
  API,
  createCatalogProviderAndCommand,
  createProviderlessCommand,
  setupRealCliRepo,
} from "./real-cli-setup.ts";
import {
  attachRealCliHostInventory,
  createProviderAccount,
  startRealCliDaemon,
} from "./real-cli-setup-host.ts";

/** Any Provider Account cools down for at least this long once it self-reports a usage limit. */
const USAGE_LIMIT_COOLDOWN_SECONDS = 120;

type ProviderAccountDetail = {
  id: string;
  usageLimitedUntil: string | null;
  lastUsageLimitedAt: string | null;
};

type SessionDetail = {
  id: string;
  status: string;
  errorCode: string | null;
  resolvedRoute?: { targetIndex: number; commandId: string; providerAccountId?: string };
};

/**
 * Run one real, out-of-usage CLI (`providerName`) against its exact catalog preset, targeted
 * as the session's primary route with a providerless `echo` fallback. Asserts the durable,
 * post-hoc-observable facts documented in docs/host-daemon.md#usage-limits-ai-vendor--cli-quotas
 * and docs/api.md's `POST /sessions` usage-limit paragraph:
 *
 *  - the Provider Account is paused (`usageLimitedUntil` in the future, `lastUsageLimitedAt` set)
 *  - the session did NOT complete on the provider target — it completed via the fallback
 *    (`resolvedRoute.targetIndex` advanced past 0, to the echo Command)
 *
 * We deliberately do not try to catch a transient `session.errorCode === "usage_limit"` mid-run:
 * `control-plane-assign.ts` (`delete session.errorCode`) and the durable equivalent
 * (`plane-storage-sessions-assign.ts`'s `REMOVE ... errorCode`) both clear it the instant the
 * session is reassigned to the fallback, and that reassignment happens synchronously inside the
 * same host-report handling that recorded the usage limit — before this test's own poll loop
 * ever gets a turn. The durable cooldown + resolved-route fields above are the only
 * non-racy proof available from the API.
 */
export async function runUsageLimitSession(opts: {
  request: APIRequestContext;
  providerName: "claude" | "codex" | "grok";
}): Promise<{ session: SessionDetail; account: ProviderAccountDetail }> {
  const { request, providerName } = opts;
  const preset = catalogCommandDefaults(providerName);
  if (!preset) throw new Error(`no catalog preset for ${providerName}`);
  const catalogName = `usage-limit-${providerName}-${Date.now()}`;
  let stopDaemon: (() => Promise<void>) | undefined;
  const { root, repo, wt, hostId, repoId, wtId } = await setupRealCliRepo(providerName);

  try {
    const { provider } = await createCatalogProviderAndCommand(request, {
      catalogName,
      argv: preset.argv,
      appendPrompt: preset.appendPrompt,
      appendPromptSeparator: preset.appendPromptSeparator,
    });
    const account = await createProviderAccount(request, {
      providerId: provider.id,
      label: "e2e-usage-limit",
      usageLimitCooldownSeconds: USAGE_LIMIT_COOLDOWN_SECONDS,
    });
    const echo = await createProviderlessCommand(request, {
      name: `${catalogName}-echo-fallback`,
      argv: ["echo"],
      appendPrompt: true,
    });
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

    const sessionRes = await request.post(`${API}/api/v1/sessions`, {
      data: {
        repositoryId,
        prompt: "Reply with exactly: hello world. Do not use any tools.",
        target: { providerId: provider.id },
        fallbacks: [{ commandId: echo.id }],
        timeout: 120,
      },
    });
    expect(sessionRes.ok(), `create session failed: ${await sessionRes.text()}`).toBeTruthy();
    const { id: sessionId } = (await sessionRes.json()) as { id: string };

    let session: SessionDetail = { id: sessionId, status: "queued", errorCode: null };
    for (let i = 0; i < 180 && session.status !== "completed" && session.status !== "failed"; i++) {
      await request.post(`${API}/api/v1/scheduler/assign`);
      await new Promise((r) => setTimeout(r, 1_000));
      const res = await request.get(`${API}/api/v1/sessions/${sessionId}`);
      session = (await res.json()) as SessionDetail;
    }
    expect(session.status, JSON.stringify(session)).toBe("completed");
    expect(session.resolvedRoute?.targetIndex, JSON.stringify(session.resolvedRoute)).toBe(1);
    expect(session.resolvedRoute?.commandId).toBe(echo.id);

    const accountRes = await request.get(`${API}/api/v1/provider-accounts/${account.id}`);
    expect(accountRes.ok(), `get provider account failed: ${await accountRes.text()}`).toBeTruthy();
    const accountDetail = (await accountRes.json()) as ProviderAccountDetail;
    expect(accountDetail.usageLimitedUntil, JSON.stringify(accountDetail)).not.toBeNull();
    expect(Date.parse(accountDetail.usageLimitedUntil!)).toBeGreaterThan(Date.now());
    expect(accountDetail.lastUsageLimitedAt).not.toBeNull();

    return { session, account: accountDetail };
  } finally {
    await stopDaemon?.();
    rmSync(root, { recursive: true, force: true });
  }
}
