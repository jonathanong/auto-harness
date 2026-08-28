import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import {
  buildProviderCatalog,
  resolveScheduledSessionTarget,
  resolveSessionTargetRoute,
  resolveSessionTargetRouteAt,
} from "./control-plane-session-target.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "missing" },
    fallbacks: [],
    targetDisplayNames: ["missing"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    type: "prompt",
    source: "api",
    ...over,
  };
}

const worktree: WorktreeRecord = {
  id: "w",
  name: "w",
  hostId: "host",
  repositoryId: "repo",
  path: "/repo/w",
  labels: [],
  status: "idle",
  online: true,
};

function resumed(accountId?: string): SessionRecord {
  return session({
    resumedFromSessionId: "old",
    resumeFallback: true,
    pinnedTargetIndex: 0,
    pinnedCommandId: "frozen",
    ...(accountId ? { pinnedProviderAccountId: accountId } : {}),
    resumeSpec: { argv: ["frozen"], appendPrompt: false },
  });
}

describe("target routing residual coverage", () => {
  it("rejects a frozen account route when its account disappeared", () => {
    const state = createControlPlaneState({ now: () => NOW });
    expect(
      resolveSessionTargetRouteAt(
        state,
        buildProviderCatalog(state),
        resumed("gone"),
        worktree,
        Date.parse(NOW),
        0,
      ),
    ).toBeNull();
  });

  it("rejects limited and scope-disabled frozen account routes", () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.providerAccounts.set("account", {
      id: "account",
      providerId: "provider",
      label: "account",
      usageLimitedUntil: "2026-01-02T00:00:00.000Z",
    });
    const route = () =>
      resolveSessionTargetRouteAt(
        state,
        buildProviderCatalog(state),
        resumed("account"),
        worktree,
        Date.parse(NOW),
        0,
      );
    expect(route()).toBeNull();
    state.providerAccounts.get("account")!.usageLimitedUntil = null;
    expect(route()).toBeNull();
  });

  it("requires a native resume reference when the frozen template uses one", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const row = resumed();
    row.resumeSpec = {
      argv: ["tool"],
      appendPrompt: false,
      resumeArgvTemplate: ["--resume", "{ref}"],
    };
    expect(
      resolveSessionTargetRouteAt(
        state,
        buildProviderCatalog(state),
        row,
        worktree,
        Date.parse(NOW),
        0,
      ),
    ).toBeNull();
  });

  it("rejects unsafe frozen resume templates before materializing argv", () => {
    const state = createControlPlaneState({ now: () => NOW });
    for (const resumeArgvTemplate of [
      ["/bin/tool", "{cliResumeRef}"],
      ["bin/../tool", "{cliResumeRef}"],
      ["{prompt}", "{cliResumeRef}"],
    ]) {
      const row = resumed();
      row.cliResumeRef = "ref";
      row.resumeSpec = {
        argv: ["frozen"],
        appendPrompt: false,
        resumeArgvTemplate,
      };
      expect(
        resolveSessionTargetRouteAt(
          state,
          buildProviderCatalog(state),
          row,
          worktree,
          Date.parse(NOW),
          0,
        ),
      ).toBeNull();
    }
  });

  it("rejects a resolved route whose frozen command pin changed", () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.commands.set("cmd", {
      id: "cmd",
      name: "cmd",
      argv: ["echo"],
      appendPrompt: false,
      providerId: null,
    });
    expect(
      resolveSessionTargetRoute(
        state,
        buildProviderCatalog(state),
        session({ target: { commandId: "cmd" }, pinnedHostId: "host", pinnedCommandId: "old" }),
        worktree,
        Date.parse(NOW),
      ),
    ).toBeNull();
  });

  it("skips a suppressed scheduled target and honors a provider pin", () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.hostInventories.set("host", {
      hostId: "host",
      repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
      providerAccounts: [],
      commandProfiles: {},
      updatedAt: NOW,
    });
    expect(
      resolveScheduledSessionTarget(
        state,
        buildProviderCatalog(state),
        session({ suppressedTargetIndexes: [0] }),
        "host",
      ),
    ).toBeNull();
  });
});
