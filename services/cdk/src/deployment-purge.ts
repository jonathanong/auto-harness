import { awsArgs, cdkContext, queryOk } from "./deployment-support.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import type { DeploymentDependencies } from "./deployment-support.ts";

const MAX_DELETE_OBJECTS_PER_CALL = 1000;

type S3ObjectVersion = { Key: string; VersionId: string };
type S3ListObjectVersionsResponse = {
  DeleteMarkers?: S3ObjectVersion[];
  IsTruncated?: boolean;
  NextKeyMarker?: string;
  NextVersionIdMarker?: string;
  Versions?: S3ObjectVersion[];
};
type SsmDeleteParametersResponse = { DeletedParameters?: string[]; InvalidParameters?: string[] };

/**
 * Deploys only the foundation stack, forcing removalPolicy=destroy regardless of the
 * environment's configured policy. This flips every retained resource's DeletionPolicy /
 * UpdateReplacePolicy to Delete in the live CloudFormation template — the original deploy's
 * DeletionPolicy: Retain would otherwise orphan the tables, archive bucket, and KMS key
 * rather than remove them when the stack is later destroyed. Needs no --parameters: nothing
 * in the foundation stack depends on runtime's SSM parameter values.
 */
export async function retargetFoundationForDeletion(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  dependencies.log(`Retargeting ${config.foundationStackName} for deletion...`);
  await dependencies.run("pnpm", [
    "exec",
    "cdk",
    "deploy",
    config.foundationStackName,
    ...cdkContext({ ...config, removalPolicy: "destroy" }),
    "--require-approval",
    "never",
  ]);
}

async function listObjectVersionsPage(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  bucketName: string,
  keyMarker: string | undefined,
  versionIdMarker: string | undefined,
): Promise<S3ListObjectVersionsResponse> {
  const stdout = await queryOk(
    dependencies,
    "aws",
    awsArgs(config, [
      "s3api",
      "list-object-versions",
      "--bucket",
      bucketName,
      "--output",
      "json",
      ...(keyMarker ? ["--key-marker", keyMarker] : []),
      ...(versionIdMarker ? ["--version-id-marker", versionIdMarker] : []),
    ]),
  );
  return stdout ? (JSON.parse(stdout) as S3ListObjectVersionsResponse) : {};
}

async function deleteObjectVersions(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  bucketName: string,
  objects: S3ObjectVersion[],
): Promise<void> {
  for (let start = 0; start < objects.length; start += MAX_DELETE_OBJECTS_PER_CALL) {
    const batch = objects.slice(start, start + MAX_DELETE_OBJECTS_PER_CALL);
    await queryOk(
      dependencies,
      "aws",
      awsArgs(config, [
        "s3api",
        "delete-objects",
        "--bucket",
        bucketName,
        "--delete",
        JSON.stringify({
          Objects: batch.map((object) => ({ Key: object.Key, VersionId: object.VersionId })),
          Quiet: true,
        }),
      ]),
    );
  }
}

/**
 * Empties a versioned S3 bucket completely: `aws s3 rm --recursive` only removes the current
 * version of each key, leaving noncurrent versions and delete markers behind, and `cdk
 * destroy` then fails with BucketNotEmpty. This paginates the full version listing and
 * deletes every Version and DeleteMarker, batched at S3's 1000-object-per-call limit.
 */
export async function emptyArchiveBucket(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  bucketName: string,
): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  let deletedCount = 0;
  for (;;) {
    const page = await listObjectVersionsPage(
      config,
      dependencies,
      bucketName,
      keyMarker,
      versionIdMarker,
    );
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
    if (objects.length > 0) {
      await deleteObjectVersions(config, dependencies, bucketName, objects);
      deletedCount += objects.length;
    }
    if (!page.IsTruncated) break;
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
  dependencies.log(`Emptied ${String(deletedCount)} object version(s) from ${bucketName}.`);
}

/**
 * Opt-in only (config.purgeSsmParameters): these SSM parameters are hand-managed and may be
 * shared across environments, so deleting them is never implied by the other purge steps.
 * Missing parameters are reported, not treated as a failure — deleting an already-absent
 * parameter isn't a real error.
 */
export async function deleteSecretParameters(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  const names = [config.adminsSsmParam, config.sessionSecretSsmParam, config.cursorSecretSsmParam];
  const stdout = await queryOk(
    dependencies,
    "aws",
    awsArgs(config, ["ssm", "delete-parameters", "--names", ...names, "--output", "json"]),
  );
  const result: SsmDeleteParametersResponse = stdout ? JSON.parse(stdout) : {};
  dependencies.log(
    `Deleted SSM parameters: ${(result.DeletedParameters ?? []).join(", ") || "(none)"}`,
  );
  if (result.InvalidParameters?.length) {
    dependencies.log(`SSM parameters already absent: ${result.InvalidParameters.join(", ")}`);
  }
}
