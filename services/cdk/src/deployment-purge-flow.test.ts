import { describe, expect, it, vi } from "vitest";

import { config, dependencies } from "./deployment-test-helpers.ts";
import { runDeployment } from "./deployment.ts";

describe("runDeployment purge", () => {
  it("requires both confirmations before touching anything", async () => {
    const noConfirm = dependencies([true, true, true]);
    await expect(runDeployment("purge", config(), noConfirm)).rejects.toThrow(
      "HARNESS_DEPLOY_CONFIRM=review",
    );
    expect(noConfirm.queries).toHaveLength(0);

    const noPurgeConfirm = dependencies([true, true, true]);
    await expect(
      runDeployment("purge", config({ teardownConfirmation: "review" }), noPurgeConfirm),
    ).rejects.toThrow("HARNESS_DEPLOY_PURGE_CONFIRM=destroy-all-data-in-review");
    expect(noPurgeConfirm.queries).toHaveLength(0);

    // The teardown confirmation alone is not enough, and neither is the purge confirmation
    // alone — both single-field checks above prove that; a mismatched purge confirmation
    // (naming a different environment) must fail the same way.
    await expect(
      runDeployment(
        "purge",
        config({
          purgeConfirmation: "destroy-all-data-in-staging",
          teardownConfirmation: "review",
        }),
        dependencies([true, true, true]),
      ),
    ).rejects.toThrow("HARNESS_DEPLOY_PURGE_CONFIRM=destroy-all-data-in-review");
  });

  it("refuses when no application stack exists", async () => {
    await expect(
      runDeployment(
        "purge",
        config({
          purgeConfirmation: "destroy-all-data-in-review",
          teardownConfirmation: "review",
        }),
        dependencies([false, false, false]),
      ),
    ).rejects.toThrow("no application stacks");
  });

  it("destroys web+runtime, retargets and empties the foundation, then destroys it — in that order", async () => {
    const deps = dependencies([true, true, true, false, false, false]);
    await runDeployment(
      "purge",
      config({
        purgeConfirmation: "destroy-all-data-in-review",
        teardownConfirmation: "review",
      }),
      deps,
    );

    expect(deps.runs).toHaveLength(3);
    expect(deps.runs[0]).toEqual(
      expect.arrayContaining([
        "destroy",
        "AutoHarness-review-Web",
        "AutoHarness-review-Runtime",
        "--force",
      ]),
    );
    expect(deps.runs[0]).not.toContain("AutoHarness-review-Foundation");
    // The retarget deploy forces removalPolicy=destroy regardless of the environment's
    // actual configured policy, and needs no --parameters (nothing in the foundation stack
    // depends on runtime's SSM parameter values).
    expect(deps.runs[1]).toEqual(
      expect.arrayContaining([
        "deploy",
        "AutoHarness-review-Foundation",
        "-c",
        "removalPolicy=destroy",
      ]),
    );
    expect(deps.runs[1]).not.toContain("--parameters");
    expect(deps.runs[1]).not.toContain("AutoHarness-review-Runtime");
    expect(deps.runs[1]).not.toContain("AutoHarness-review-Web");
    expect(deps.runs[2]).toEqual(
      expect.arrayContaining(["destroy", "AutoHarness-review-Foundation", "--force"]),
    );
    expect(deps.runs[2]).not.toContain("AutoHarness-review-Runtime");
    expect(deps.runs[2]).not.toContain("AutoHarness-review-Web");
    // The bucket was actually emptied (not skipped) as part of the middle phase.
    expect(deps.queries.some((q) => q.includes("list-object-versions"))).toBe(true);
    // SSM parameters are opt-in; the default config here doesn't ask for it.
    expect(deps.queries.some((q) => q.includes("delete-parameters"))).toBe(false);
  });

  it("skips the retarget/empty/destroy-foundation phase when foundation is already absent", async () => {
    const deps = dependencies([false, true, true, false, false, false]);
    await runDeployment(
      "purge",
      config({
        purgeConfirmation: "destroy-all-data-in-review",
        teardownConfirmation: "review",
      }),
      deps,
    );
    expect(deps.runs).toHaveLength(1);
    expect(deps.runs[0]).toEqual(
      expect.arrayContaining(["destroy", "AutoHarness-review-Web", "AutoHarness-review-Runtime"]),
    );
    expect(deps.queries.some((q) => q.includes("list-object-versions"))).toBe(false);
  });

  it("destroys only the foundation when web and runtime were already torn down", async () => {
    const deps = dependencies([true, false, false, false, false, false]);
    await runDeployment(
      "purge",
      config({
        purgeConfirmation: "destroy-all-data-in-review",
        teardownConfirmation: "review",
      }),
      deps,
    );
    // No web/runtime destroy call at all — only the retarget deploy and the foundation
    // destroy, since destroyStacks([]) is never invoked for an empty stack-name list.
    expect(deps.runs).toHaveLength(2);
    expect(deps.runs[0]).toEqual(
      expect.arrayContaining(["deploy", "AutoHarness-review-Foundation"]),
    );
    expect(deps.runs[1]).toEqual(
      expect.arrayContaining(["destroy", "AutoHarness-review-Foundation", "--force"]),
    );
  });

  it("deletes SSM parameters only when explicitly opted in", async () => {
    const deps = dependencies([true, true, true, false, false, false]);
    await runDeployment(
      "purge",
      config({
        purgeConfirmation: "destroy-all-data-in-review",
        purgeSsmParameters: true,
        teardownConfirmation: "review",
      }),
      deps,
    );
    expect(deps.queries.some((q) => q.includes("delete-parameters"))).toBe(true);
  });

  it("throws when a stack survives the destroy phases", async () => {
    const deps = dependencies([true, true, true, true, false, false]);
    await expect(
      runDeployment(
        "purge",
        config({
          purgeConfirmation: "destroy-all-data-in-review",
          teardownConfirmation: "review",
        }),
        deps,
      ),
    ).rejects.toThrow("surviving application stack");
  });

  it("never destroys the foundation when emptying its archive bucket fails", async () => {
    const deps = dependencies([true, true, true, false, false, false]);
    const query = deps.query;
    deps.query = vi.fn(async (command, args) => {
      if (args.includes("delete-objects")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            Errors: [{ Code: "AccessDenied", Key: "sessions/a.log", VersionId: "v1" }],
          }),
        };
      }
      if (args.includes("list-object-versions")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({ Versions: [{ Key: "sessions/a.log", VersionId: "v1" }] }),
        };
      }
      return query(command, args);
    });
    await expect(
      runDeployment(
        "purge",
        config({
          purgeConfirmation: "destroy-all-data-in-review",
          teardownConfirmation: "review",
        }),
        deps,
      ),
    ).rejects.toThrow("AccessDenied");
    // web+runtime and the retarget deploy ran, but the foundation destroy never did.
    expect(deps.runs).toHaveLength(2);
    expect(
      deps.runs.some(
        (run) => run.includes("destroy") && run.includes("AutoHarness-review-Foundation"),
      ),
    ).toBe(false);
  });
});
