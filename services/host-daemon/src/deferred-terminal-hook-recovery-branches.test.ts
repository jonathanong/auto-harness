import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createDeferredTerminalHookSettlement } from "./deferred-terminal-hook.ts";
import { GITHUB_APP_TOKEN_MARGIN_MS, parseGitHubAppConfig } from "./github-app.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();

function githubApp() {
  return parseGitHubAppConfig(
    {
      appId: "1",
      privateKeyPath: "/keys/app.pem",
      botLogin: "auto-harness[bot]",
      botUserId: 2,
      repositories: { "repo-1": { installationId: 3, repositoryId: 4 } },
    },
    () => pem,
  );
}

function tokenResponse(expiresAt: string): Response {
  return new Response(
    JSON.stringify({
      token: "ghs_recovery-branches",
      expires_at: expiresAt,
      permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        metadata: "read",
      },
      repositories: [{ id: 4 }],
    }),
    { status: 201 },
  );
}

function settlement(
  overrides: Partial<Parameters<typeof createDeferredTerminalHookSettlement>[0]> = {},
) {
  return createDeferredTerminalHookSettlement({
    processRunner: {
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    },
    streamer: { write: vi.fn() } as never,
    assign: { sessionId: "session" } as never,
    claimed: { currentHookTarget: async () => ({ cwd: process.cwd(), repository: {} }) },
    status: "failed",
    errorCode: undefined,
    childEnvSource: { PATH: process.env.PATH },
    environmentIsChild: true,
    ...overrides,
  });
}

describe("deferred terminal-hook recovery branch coverage", () => {
  it("covers no-op, missing-target, and unmapped hook option branches", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, timedOut: false, signal: null }));
    const noOp = settlement({ processRunner: { run } });
    await expect(noOp(false)).resolves.toBeUndefined();

    const missingTarget = settlement({
      processRunner: { run },
      claimed: { currentHookTarget: async () => null },
    });
    await expect(missingTarget(true)).resolves.toBeUndefined();

    const unmapped = settlement({
      processRunner: { run },
      assign: {
        sessionId: "session",
        repositoryId: "other",
        ref: "feature/recovery",
        metadata: { source: "coverage" },
      } as never,
      claimed: {
        currentHookTarget: async () => ({
          cwd: process.cwd(),
          repository: { terminalHookScript: "missing-hook.sh" },
          allowedRoots: [process.cwd()],
        }),
      },
      errorCode: "checkout_fetch_failed",
      baseline: "baseline",
      environmentIsChild: false,
    });
    await expect(unmapped(true)).resolves.toMatchObject({ summarySource: "harness" });
    expect(run).toHaveBeenCalled();
  });

  it("covers mapped token-expiry and handoff-deadline fail-closed branches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tokenResponse(new Date(Date.now() + GITHUB_APP_TOKEN_MARGIN_MS - 1).toISOString()),
      ),
    );
    const nearExpiry = settlement({
      assign: { sessionId: "session", repositoryId: "repo-1" } as never,
      githubApp: githubApp(),
    });
    try {
      await expect(nearExpiry(true, Date.now() + 10_000)).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return tokenResponse(new Date(Date.now() + 60 * 60_000).toISOString());
      }),
    );
    const deadlineExpired = settlement({
      assign: { sessionId: "session", repositoryId: "repo-1" } as never,
      githubApp: githubApp(),
    });
    try {
      await expect(deadlineExpired(true, Date.now() + 5)).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("covers mapped recovery with no handoff deadline and an already-aborted credential deadline", async () => {
    const now = vi.spyOn(Date, "now");
    let calls = 0;
    now.mockImplementation(() => {
      calls += 1;
      // The deadline is checked as live work begins, then advances before the
      // recovery credential timer is calculated.
      return calls === 4 ? 200 : 0;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse("2099-01-01T00:00:00.000Z")),
    );
    try {
      const noHandoffDeadline = settlement({
        assign: { sessionId: "session", repositoryId: "repo-1" } as never,
        githubApp: githubApp(),
      });
      await expect(noHandoffDeadline(true)).resolves.toMatchObject({
        summarySource: "harness",
      });
      expect(calls).toBe(999);
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("rethrows an unmapped retained-claim failure", async () => {
    const invalidEnvironment = settlement({
      assign: { sessionId: "session", repositoryId: "other" } as never,
      claimed: {
        currentHookTarget: async () => ({
          cwd: process.cwd(),
          repository: {
            get terminalHookScript(): string {
              throw new Error("retained claim became unreadable");
            },
          },
        }),
      },
    });

    await expect(invalidEnvironment(true)).rejects.toThrow("retained claim became unreadable");
  });
});
