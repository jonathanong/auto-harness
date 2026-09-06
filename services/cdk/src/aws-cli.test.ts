import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { awsArgs, awsCliEnv } from "./aws-cli.ts";
import { config } from "./deployment-test-helpers.ts";

describe("aws CLI helpers", () => {
  it("disables the AWS CLI pager so deploy output is not trapped in less", () => {
    expect(awsArgs(config(), ["lambda", "update-function-configuration"])).toEqual([
      "--no-cli-pager",
      "lambda",
      "update-function-configuration",
      "--region",
      "us-west-2",
    ]);
    expect(awsCliEnv({ PATH: "/bin", AWS_PAGER: "less" })).toEqual({
      PATH: "/bin",
      AWS_PAGER: "",
    });
    expect(
      readFileSync(new URL("../../../scripts/aws-deployment.mts", import.meta.url), "utf8"),
    ).toContain("env: awsCliEnv()");
  });
});
