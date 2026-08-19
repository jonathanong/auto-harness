import type { DeploymentConfig } from "./deployment-config.ts";

type RecycleDependencies = {
  log: (message: string) => void;
  query: (
    command: string,
    args: string[],
  ) => Promise<{ status: number | null; stderr: string; stdout: string }>;
  run: (command: string, args: string[]) => Promise<void>;
};

/** Force runtime Lambdas to cold-start so they re-read PUBLIC_BASE_URL_SSM_PARAM. */
export async function recycleRuntimeLambdas(
  config: DeploymentConfig,
  dependencies: RecycleDependencies,
): Promise<void> {
  const result = await dependencies.query("aws", [
    "cloudformation",
    "list-stack-resources",
    "--stack-name",
    config.runtimeStackName,
    "--query",
    "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId",
    "--output",
    "text",
    "--region",
    config.region,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `aws cloudformation list-stack-resources failed: ${result.stderr || result.stdout}`,
    );
  }
  const names = result.stdout.trim().split(/\s+/).filter(Boolean);
  for (const name of names) {
    await dependencies.run("aws", [
      "lambda",
      "update-function-configuration",
      "--function-name",
      name,
      "--description",
      `public-base-url recycle ${config.publicBaseUrlSsmParam}`,
      "--region",
      config.region,
    ]);
  }
  if (names.length > 0) {
    dependencies.log(
      `Recycled ${String(names.length)} runtime Lambda(s) to pick up ${config.publicBaseUrlSsmParam}`,
    );
  }
}
