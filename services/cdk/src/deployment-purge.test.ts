import { describe, expect, it, vi } from "vitest";

import type { DeploymentConfig } from "./deployment-config.ts";
import type { DeploymentDependencies } from "./deployment-support.ts";
import {
  deleteSecretParameters,
  emptyArchiveBucket,
  retargetFoundationForDeletion,
} from "./deployment-purge.ts";

const config: DeploymentConfig = {
  adminsSsmParam: "/auto-harness/review/harness-admins",
  cursorSecretSsmParam: "/auto-harness/review/harness-cursor-secret",
  environment: "review",
  foundationStackName: "AutoHarness-review-Foundation",
  publicBaseUrlSsmParam: "/auto-harness/review/public-base-url",
  purgeSsmParameters: false,
  region: "us-west-2",
  removalPolicy: "retain",
  runtimeStackName: "AutoHarness-review-Runtime",
  sessionSecretSsmParam: "/auto-harness/review/harness-session-secret",
  tablePrefix: "AutoHarness-review",
  webStackName: "AutoHarness-review-Web",
};

function deletePayload(args: string[]): { Objects: unknown[]; Quiet?: boolean } {
  return JSON.parse(args[args.indexOf("--delete") + 1]!) as { Objects: unknown[]; Quiet?: boolean };
}

function dependencies(
  query: DeploymentDependencies["query"],
): DeploymentDependencies & { runs: string[][] } {
  const runs: string[][] = [];
  return {
    fetch: vi.fn(),
    log: vi.fn(),
    query,
    run: vi.fn(async (command, args) => {
      runs.push([command, ...args]);
    }),
    runs,
  };
}

describe("retargetFoundationForDeletion", () => {
  it("deploys only the foundation stack, forcing removalPolicy=destroy", async () => {
    const deps = dependencies(vi.fn());
    await retargetFoundationForDeletion(config, deps);
    expect(deps.runs).toHaveLength(1);
    const [command, ...args] = deps.runs[0]!;
    expect(command).toBe("pnpm");
    expect(args).toEqual(
      expect.arrayContaining(["deploy", "AutoHarness-review-Foundation", "--require-approval"]),
    );
    expect(args).not.toContain("AutoHarness-review-Runtime");
    expect(args).not.toContain("AutoHarness-review-Web");
    expect(args).not.toContain("--parameters");
    expect(args).toEqual(expect.arrayContaining(["-c", "removalPolicy=destroy"]));
  });
});

describe("emptyArchiveBucket", () => {
  it("does nothing to an already-empty bucket", async () => {
    const query = vi.fn(async () => ({ status: 0, stderr: "", stdout: "{}" }));
    const deps = dependencies(query);
    await emptyArchiveBucket(config, deps, "review-archive-bucket");
    expect(query).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(
      "Emptied 0 object version(s) from review-archive-bucket.",
    );
  });

  it("treats an empty CLI response the same as an empty listing", async () => {
    // The real AWS CLI can return a blank stdout rather than "{}" for a bucket with no
    // versions at all; queryOk() trims it to "", which must fall back the same way.
    const query = vi.fn(async () => ({ status: 0, stderr: "", stdout: "" }));
    const deps = dependencies(query);
    await emptyArchiveBucket(config, deps, "review-archive-bucket");
    expect(deps.log).toHaveBeenCalledWith(
      "Emptied 0 object version(s) from review-archive-bucket.",
    );
  });

  it("deletes both versions and delete markers, paginating and batching past 1000 keys", async () => {
    const firstPageVersions = Array.from({ length: 1000 }, (_, i) => ({
      Key: `sessions/${String(i)}.log`,
      VersionId: `v${String(i)}`,
    }));
    const secondPageVersions = [{ Key: "sessions/1000.log", VersionId: "v1000" }];
    const deleteMarkers = [{ Key: "sessions/deleted.log", VersionId: "dm1" }];
    const query = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("list-object-versions")) {
        if (args.includes("--key-marker")) {
          return {
            status: 0,
            stderr: "",
            stdout: JSON.stringify({
              DeleteMarkers: deleteMarkers,
              Versions: secondPageVersions,
            }),
          };
        }
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            IsTruncated: true,
            NextKeyMarker: "sessions/999.log",
            NextVersionIdMarker: "v999",
            Versions: firstPageVersions,
          }),
        };
      }
      return { status: 0, stderr: "", stdout: "" };
    });
    const deps = dependencies(query);
    await emptyArchiveBucket(config, deps, "review-archive-bucket");

    const deleteCalls = query.mock.calls.filter(([, args]) => args.includes("delete-objects"));
    // 1000 objects from the first page batched into one delete-objects call, plus a second
    // call for the second page's 1 version + 1 delete marker — never more than 1000 per call.
    expect(deleteCalls).toHaveLength(2);
    const firstBatch = deletePayload(deleteCalls[0]![1]);
    expect(firstBatch.Objects).toHaveLength(1000);
    expect(firstBatch.Quiet).toBe(true);
    const secondBatch = deletePayload(deleteCalls[1]![1]);
    expect(secondBatch.Objects).toHaveLength(2);
    expect(deps.log).toHaveBeenCalledWith(
      "Emptied 1002 object version(s) from review-archive-bucket.",
    );
  });

  it("throws on a per-object delete failure instead of reporting the bucket empty", async () => {
    // delete-objects exits 0 even when some objects failed — the failure is only visible in
    // the response body's Errors array, not the CLI status queryOk() checks.
    const query = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("list-object-versions")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            Versions: [
              { Key: "sessions/a.log", VersionId: "v1" },
              { Key: "sessions/b.log", VersionId: "v2" },
            ],
          }),
        };
      }
      if (args.includes("delete-objects")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            // A second, fieldless entry covers the "AWS omitted this field" fallback path —
            // documented as possible in the DeleteObjects API but not the common case.
            Errors: [{ Code: "AccessDenied", Key: "sessions/b.log", VersionId: "v2" }, {}],
          }),
        };
      }
      return { status: 0, stderr: "", stdout: "" };
    });
    const deps = dependencies(query);
    await expect(emptyArchiveBucket(config, deps, "review-archive-bucket")).rejects.toThrow(
      "sessions/b.log@v2: AccessDenied, (unknown)@(unknown): unknown",
    );
    // Pagination must not continue past a batch that failed to delete.
    expect(
      query.mock.calls.filter(([, args]) => args.includes("list-object-versions")),
    ).toHaveLength(1);
  });
});

describe("deleteSecretParameters", () => {
  it("reports deleted parameters and any already absent", async () => {
    const query = vi.fn(async () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        DeletedParameters: [
          "/auto-harness/review/harness-admins",
          "/auto-harness/review/harness-session-secret",
        ],
        InvalidParameters: ["/auto-harness/review/harness-cursor-secret"],
      }),
    }));
    const deps = dependencies(query);
    await deleteSecretParameters(config, deps);
    expect(query).toHaveBeenCalledWith(
      "aws",
      expect.arrayContaining([
        "ssm",
        "delete-parameters",
        "--names",
        "/auto-harness/review/harness-admins",
        "/auto-harness/review/harness-cursor-secret",
        "/auto-harness/review/harness-session-secret",
        "/auto-harness/review/public-base-url",
      ]),
    );
    expect(deps.log).toHaveBeenCalledWith(
      "Deleted SSM parameters: /auto-harness/review/harness-admins, /auto-harness/review/harness-session-secret",
    );
    expect(deps.log).toHaveBeenCalledWith(
      "SSM parameters already absent: /auto-harness/review/harness-cursor-secret",
    );
  });

  it("reports none deleted without a trailing empty list when nothing existed", async () => {
    const query = vi.fn(async () => ({ status: 0, stderr: "", stdout: "{}" }));
    const deps = dependencies(query);
    await deleteSecretParameters(config, deps);
    expect(deps.log).toHaveBeenCalledWith("Deleted SSM parameters: (none)");
  });

  it("treats an empty CLI response the same as an empty result", async () => {
    const query = vi.fn(async () => ({ status: 0, stderr: "", stdout: "" }));
    const deps = dependencies(query);
    await deleteSecretParameters(config, deps);
    expect(deps.log).toHaveBeenCalledWith("Deleted SSM parameters: (none)");
  });
});
