import { describe, expect, it, vi } from "vitest";

import { config, dependencies } from "./deployment-test-helpers.ts";
import { runDeployment } from "./deployment.ts";

describe("runDeployment", () => {
  it("bootstraps, deploys, verifies stacks, and health-checks a new environment", async () => {
    const deps = dependencies([false, false, false, true, true, true]);
    await runDeployment("deploy", config(), deps);
    expect(deps.runs[0]).toEqual([
      "pnpm",
      "exec",
      "cdk",
      "bootstrap",
      "aws://123456789012/us-west-2",
    ]);
    expect(deps.runs[1]).toEqual(
      expect.arrayContaining([
        "deploy",
        "AutoHarness-review-Foundation",
        "--parameters",
        "AutoHarness-review-Runtime:HarnessPublicBaseUrlSsmParam=/auto-harness/review/public-base-url",
      ]),
    );
    expect(deps.fetch).toHaveBeenCalledWith(new URL("https://api.example.test/health"));
    // The agent endpoint is derived from WebUrl, not printed from the runtime stack's raw
    // WebSocketUrl output — a host daemon must never be handed the execute-api hostname.
    expect(deps.log).toHaveBeenCalledWith("Agent WebSocket endpoint: wss://api.example.test/ws");
    expect(deps.log).toHaveBeenCalledWith(
      "Set on each host: HARNESS_API_URL=https://api.example.test",
    );
    // Runtime cannot know WebUrl at synth/deploy time (Web depends on Runtime, not the
    // reverse), so the resolved value is published to SSM only after Web is confirmed
    // healthy — not passed as a CDK deploy parameter like the three bootstrap secrets.
    expect(deps.runs).toContainEqual([
      "aws",
      "ssm",
      "put-parameter",
      "--type",
      "String",
      "--overwrite",
      "--name",
      "/auto-harness/review/public-base-url",
      "--value",
      "https://api.example.test",
      "--region",
      "us-west-2",
    ]);
    expect(deps.log).toHaveBeenCalledWith(
      "Published public base URL to /auto-harness/review/public-base-url",
    );

    const knownAccount = dependencies([false, false, false, true, true, true]);
    await runDeployment("deploy", config({ accountId: "210987654321" }), knownAccount);
    expect(knownAccount.runs[0]).toContain("aws://210987654321/us-west-2");
    expect(knownAccount.queries.flat()).not.toContain("get-caller-identity");
  });

  it("updates an existing environment and can restore a missing runtime", async () => {
    const deps = dependencies([true, true, true, true, true, true]);
    await runDeployment("update", config(), deps);
    // [0] cdk deploy, [1] the post-health-check publish of the public base URL to SSM
    // (smokeDeployment runs on update too, same as deploy).
    expect(deps.runs).toHaveLength(2);
    expect(deps.runs[0]).toEqual(expect.arrayContaining(["deploy"]));
    expect(deps.runs[1]).toEqual(expect.arrayContaining(["ssm", "put-parameter"]));

    const restore = dependencies([true, false, false, true, true, true]);
    await runDeployment("update", config(), restore);
    expect(restore.runs).toHaveLength(2);
  });

  it("rejects lifecycle misuse and unexpected AWS inspection failures", async () => {
    await expect(
      runDeployment("deploy", config(), dependencies([true, true, true])),
    ).rejects.toThrow("use update");
    await expect(
      runDeployment("update", config(), dependencies([false, false, false])),
    ).rejects.toThrow("use deploy");
    const deps = dependencies([]);
    deps.query = vi.fn(async () => ({ status: 1, stderr: "access denied", stdout: "" }));
    await expect(runDeployment("deploy", config(), deps)).rejects.toThrow("unable to inspect");

    const stdoutFailure = dependencies([]);
    stdoutFailure.query = vi.fn(async () => ({ status: 1, stderr: "", stdout: "bad request" }));
    await expect(runDeployment("deploy", config(), stdoutFailure)).rejects.toThrow("bad request");
  });

  it("stops when secret checks or post-deploy stack verification fail", async () => {
    const secretFailure = dependencies([false, false, false]);
    const query = secretFailure.query;
    secretFailure.query = vi.fn(async (command, args) =>
      args.includes("get-parameter")
        ? { status: 1, stderr: "", stdout: "parameter missing" }
        : query(command, args),
    );
    await expect(runDeployment("deploy", config(), secretFailure)).rejects.toThrow(
      "parameter missing",
    );

    await expect(
      runDeployment("deploy", config(), dependencies([false, false, false, true, false, true])),
    ).rejects.toThrow("without all application stacks");
    await expect(
      runDeployment("update", config(), dependencies([true, true, true, true, false, true])),
    ).rejects.toThrow("without all application stacks");
  });

  it("requires exact confirmation, destroys both stacks, and verifies absence", async () => {
    await expect(
      runDeployment("teardown", config(), dependencies([true, true, true])),
    ).rejects.toThrow("HARNESS_DEPLOY_CONFIRM=review");

    const deps = dependencies([true, true, true, false, false, false]);
    await runDeployment("teardown", config({ teardownConfirmation: "review" }), deps);
    expect(deps.runs[0]).toEqual(
      expect.arrayContaining([
        "destroy",
        "AutoHarness-review-Web",
        "AutoHarness-review-Runtime",
        "AutoHarness-review-Foundation",
        "--force",
      ]),
    );
  });

  it("reports missing teardown stacks and failed health checks", async () => {
    await expect(
      runDeployment(
        "teardown",
        config({ teardownConfirmation: "review" }),
        dependencies([false, false, false]),
      ),
    ).rejects.toThrow("no application stacks");

    const deps = dependencies([true, true, true, true, true, true]);
    deps.fetch = async () => new Response("no", { status: 503 });
    await expect(runDeployment("update", config(), deps)).rejects.toThrow("HTTP 503");

    const unexpectedBody = dependencies([true, true, true, true, true, true]);
    unexpectedBody.fetch = async () => new Response('{"ok":false}');
    await expect(runDeployment("update", config(), unexpectedBody)).rejects.toThrow(
      "unexpected body",
    );

    for (const output of ["", "None"]) {
      const missingOutput = dependencies([true, true, true, true, true, true]);
      const query = missingOutput.query;
      missingOutput.query = vi.fn(async (command, args) =>
        args.includes("--query") && args.includes("describe-stacks")
          ? { status: 0, stderr: "", stdout: output }
          : query(command, args),
      );
      await expect(runDeployment("update", config(), missingOutput)).rejects.toThrow(
        "no RestApiUrl",
      );
    }
  });

  it("retains the foundation while tearing down runtime resources", async () => {
    const deps = dependencies([true, true, true, true, false, false]);
    await runDeployment(
      "teardown",
      config({ removalPolicy: "retain", teardownConfirmation: "review" }),
      deps,
    );
    expect(deps.runs[0]).toEqual(
      expect.arrayContaining([
        "destroy",
        "AutoHarness-review-Web",
        "AutoHarness-review-Runtime",
        "--force",
      ]),
    );
    expect(deps.runs[0]).not.toContain("AutoHarness-review-Foundation");

    const alreadyStopped = dependencies([true, false, false, true, false, false]);
    await runDeployment(
      "teardown",
      config({ removalPolicy: "retain", teardownConfirmation: "review" }),
      alreadyStopped,
    );
    expect(alreadyStopped.runs).toHaveLength(0);
  });

  it("rejects an unexpected post-teardown stack state", async () => {
    await expect(
      runDeployment(
        "teardown",
        config({ teardownConfirmation: "review" }),
        dependencies([true, true, true, true, true, true]),
      ),
    ).rejects.toThrow("unexpected application stack state");
  });
});
