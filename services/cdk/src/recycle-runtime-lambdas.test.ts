import { describe, expect, it, vi } from "vitest";

import { config, dependencies } from "./deployment-test-helpers.ts";
import { recycleRuntimeLambdas } from "./recycle-runtime-lambdas.ts";

describe("recycleRuntimeLambdas", () => {
  it("updates each runtime Lambda configuration after public-base-url is written", async () => {
    const deps = dependencies([]);
    deps.query = vi.fn(async () => ({
      status: 0,
      stderr: "",
      stdout: "AutoHarness-review-RestFn\tAutoHarness-review-WsFn\n",
    }));
    await recycleRuntimeLambdas(config(), deps);
    expect(deps.query).toHaveBeenCalledWith(
      "aws",
      expect.arrayContaining([
        "cloudformation",
        "list-stack-resources",
        "--stack-name",
        "AutoHarness-review-Runtime",
      ]),
    );
    expect(deps.runs).toEqual([
      expect.arrayContaining([
        "lambda",
        "update-function-configuration",
        "--function-name",
        "AutoHarness-review-RestFn",
        "--description",
        "public-base-url recycle /auto-harness/review/public-base-url",
      ]),
      expect.arrayContaining([
        "lambda",
        "update-function-configuration",
        "--function-name",
        "AutoHarness-review-WsFn",
      ]),
    ]);
    expect(deps.log).toHaveBeenCalledWith(
      "Recycled 2 runtime Lambda(s) to pick up /auto-harness/review/public-base-url",
    );
  });

  it("does not touch Lambda when the runtime stack lists no functions", async () => {
    const deps = dependencies([]);
    await recycleRuntimeLambdas(config(), deps);
    expect(deps.runs).toEqual([]);
    expect(deps.log).not.toHaveBeenCalled();
  });
});
