import { awsArgs } from "./aws-cli.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import type { DeploymentDependencies } from "./deployment-support.ts";
import { DYNAMO_TABLES } from "./tables.ts";

type LiveGsi = { IndexName: string; IndexStatus: string };
type LiveTableDescription = {
  Table?: { GlobalSecondaryIndexes?: LiveGsi[]; TableStatus?: string };
};

function notActiveReasons(table: {
  GlobalSecondaryIndexes?: LiveGsi[];
  TableStatus?: string;
}): string[] {
  const gsis = table.GlobalSecondaryIndexes ?? [];
  return [
    ...(table.TableStatus === "ACTIVE" ? [] : [`table is ${table.TableStatus ?? "unknown"}`]),
    ...gsis
      .filter((gsi) => gsi.IndexStatus !== "ACTIVE")
      .map((gsi) => `${gsi.IndexName} is ${gsi.IndexStatus}`),
  ];
}

/**
 * One describe-table pass per catalog table, run before purge destroys anything. Feeds the
 * deletion retarget's per-table GSI allowlist (retargetFoundationForDeletion) so synth matches
 * each table's live index set exactly — no create/delete, only the DeletionPolicy flip —
 * regardless of how far that table has drifted from the current catalog. This is a true no-op
 * for CloudFormation only insofar as its stored template already agrees with the live table
 * (true of the reproduced production case: CloudFormation was rejecting the same 3-of-8
 * update DynamoDB was); a template that has independently drifted from the table is not
 * something this inspects.
 *
 * Also fails closed: DynamoDB refuses any UpdateTable — even one that only flips
 * DeletionProtectionEnabled — while the table or any of its GSIs isn't ACTIVE, which is
 * exactly the state an interrupted staged index rollout leaves behind. Checking this before
 * web and runtime are destroyed turns that into a clean refusal instead of a torn-down
 * environment stuck on a foundation that can't be retargeted. This does not prove the retarget
 * will succeed — only that it isn't blocked by a resource still in transition.
 *
 * A table absent from the result doesn't exist yet: a fresh CREATE can add every GSI in one
 * call, so it keeps its full catalog definition.
 */
export async function inspectLiveTables(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const existingGsiNamesByTable: Record<string, readonly string[]> = {};
  for (const definition of DYNAMO_TABLES) {
    const physicalName = `${config.tablePrefix}-${definition.name}`;
    const result = await dependencies.query(
      "aws",
      awsArgs(config, [
        "dynamodb",
        "describe-table",
        "--table-name",
        physicalName,
        "--output",
        "json",
      ]),
    );
    if (result.status !== 0) {
      if (/ResourceNotFoundException/u.test(`${result.stderr}\n${result.stdout}`)) continue;
      throw new Error(`unable to inspect ${physicalName}: ${result.stderr || result.stdout}`);
    }
    const table = (JSON.parse(result.stdout.trim() || "{}") as LiveTableDescription).Table ?? {};
    const notActive = notActiveReasons(table);
    if (notActive.length > 0) {
      throw new Error(
        `${physicalName} is mid-transition, refusing to purge: ${notActive.join(", ")}`,
      );
    }
    existingGsiNamesByTable[definition.name] = (table.GlobalSecondaryIndexes ?? []).map(
      (gsi) => gsi.IndexName,
    );
  }
  return existingGsiNamesByTable;
}
