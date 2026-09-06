import type { DeploymentConfig } from "./deployment-config.ts";

/** Empty AWS_PAGER disables AWS CLI v2's default `less` pager on a TTY. */
export function awsCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, AWS_PAGER: "" };
}

export function awsArgs(config: DeploymentConfig, args: string[]): string[] {
  return [...args, "--region", config.region];
}
