import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import {
  buildProviderCatalog,
  resolveSessionTargetRouteAt,
} from "./control-plane-session-target.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const nowMs = Date.parse("2026-01-01T00:00:00.000Z");

function worktree(): WorktreeRecord {
  return {
    id: "wt-1",
    name: "wt-1",
    hostId: "host-1",
    repositoryId: "repo-1",
    path: "/repo/wt-1",
    labels: [],
    status: "idle",
    online: true,
  };
}

function pinned(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "resume-1",
    repositoryId: "repo-1",
    prompt: "continue",
    target: { commandId: "removed-command" },
    fallbacks: [],
    targetLabels: [],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-02T00:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    resumedFromSessionId: "source-1",
    cliResumeRef: "opaque-ref",
    pinnedHostId: "host-1",
    pinnedTargetIndex: 0,
    pinnedCommandId: "removed-command",
    resumeSpec: { argv: ["tool", "resume"], appendPrompt: true },
    ...over,
  };
}

describe("native resume provider-account guard", () => {
  it("rejects absent, limited, and disabled pinned accounts before using a frozen command", () => {
    const state = createControlPlaneState();
    const session = pinned({ pinnedProviderAccountId: "account-1" });
    const resolve = () =>
      resolveSessionTargetRouteAt(
        state,
        buildProviderCatalog(state),
        session,
        worktree(),
        nowMs,
        0,
      );

    expect(resolve()).toBeNull();

    state.providerAccounts.set("account-1", {
      id: "account-1",
      providerId: "provider-1",
      label: "account",
      usageLimitedUntil: "2026-01-02T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(resolve()).toBeNull();

    state.providerAccounts.get("account-1")!.usageLimitedUntil = undefined;
    state.hostInventories.set("host-1", {
      hostId: "host-1",
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          worktrees: [
            {
              id: "wt-1",
              name: "wt-1",
              path: "/repo/wt-1",
              labels: [],
              providerAccountOverrides: { "account-1": { enabled: false } },
            },
          ],
        },
      ],
      providerAccounts: [{ providerAccountId: "account-1" }],
      commandProfiles: {},
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(resolve()).toBeNull();

    state.hostInventories.get("host-1")!.repositories[0]!.worktrees[0]!.providerAccountOverrides = {
      "account-1": { enabled: true },
    };
    expect(resolve()).toMatchObject({
      commandId: "removed-command",
      providerAccountId: "account-1",
      resolvedArgv: ["tool", "resume", "continue"],
    });
  });

  it("requires a CLI reference for a templated frozen resume and fences mismatched normal routes", () => {
    const state = createControlPlaneState();
    const template = pinned({
      cliResumeRef: undefined,
      resumeFallback: true,
      resumeSpec: {
        argv: ["tool"],
        appendPrompt: false,
        resumeArgvTemplate: ["tool", "resume", "{cliResumeRef}", "{prompt}"],
      },
    });
    expect(
      resolveSessionTargetRouteAt(
        state,
        buildProviderCatalog(state),
        template,
        worktree(),
        nowMs,
        0,
      ),
    ).toBeNull();

    state.commands.set("normal", {
      id: "normal",
      name: "normal",
      argv: ["normal"],
      appendPrompt: false,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(
      resolveSessionTargetRouteAt(
        state,
        buildProviderCatalog(state),
        pinned({ target: { commandId: "normal" }, pinnedCommandId: "different-command" }),
        worktree(),
        nowMs,
        0,
      ),
    ).toBeNull();
  });
});
