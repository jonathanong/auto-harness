import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { parseGitHubAppConfig } from "./github-app.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = key.export({ format: "pem", type: "pkcs1" }).toString();
const app = parseGitHubAppConfig(
  {
    appId: "1",
    privateKeyPath: "/key",
    botLogin: "bot",
    botUserId: 1,
    repositories: { "repo-1": { installationId: 3, repositoryId: 4 } },
  },
  () => pem,
);

describe("SessionRunner pre-command terminal hooks", () => {
  it("retains a credential-provisioning failure hook until the terminal status is durable", async () => {
    const now = Date.now();
    let mint = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        mint += 1;
        const expiresAt = new Date(now + (mint === 1 ? 60_000 : 60 * 60_000)).toISOString();
        return new Response(
          JSON.stringify({
            token: "ghs_token",
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
      }),
    );
    const hooks: string[][] = [];
    const release = vi.fn();
    const runner = new SessionRunner({
      worktrees: {
        claim: () => ({
          repository: { id: "repo-1", path: process.cwd(), defaultBranch: "main", worktrees: [] },
          worktree: { id: "wt-1", name: "wt", path: process.cwd(), labels: [] },
          cwd: process.cwd(),
          currentHookTarget: async () => ({
            cwd: process.cwd(),
            repository: { terminalHookScript: "/hook.sh" },
          }),
        }),
        prepareCheckout: async () => "baseline",
        release,
      } as never,
      githubApp: app,
      childEnvSource: { PATH: process.env.PATH },
      nowMs: () => now,
      processRunner: {
        async run(options) {
          if (options.argv[0] === "/bin/sh") hooks.push(options.argv);
          return { exitCode: 1, timedOut: false, signal: null };
        },
      },
    });
    try {
      const failed = await runner.run(baseAssign(), { deferCheckoutFetchFailureHook: true });
      expect(failed).toMatchObject({ errorCode: "setup_failed" });
      expect(failed.settleDeferredTerminalHook).toEqual(expect.any(Function));
      expect(hooks).toEqual([]);
      expect(release).not.toHaveBeenCalled();
      await failed.settleDeferredTerminalHook?.(true, Date.now() + 10_000);
      expect(hooks).toEqual([["/bin/sh", "/hook.sh"]]);
      expect(release).toHaveBeenCalledWith("wt-1");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
