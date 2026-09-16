import { awsArgs } from "./aws-cli.ts";
import { queryOk } from "./deployment-support.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import type { DeploymentDependencies } from "./deployment-support.ts";
import { DYNAMO_TABLES } from "./tables.ts";

type CloudFormationResource = { Properties?: Record<string, unknown>; Type?: string };
type CloudFormationTemplate = { Resources?: Record<string, CloudFormationResource> };
type GetTemplateResponse = { TemplateBody?: unknown };

function parseTemplateBody(templateBody: unknown): CloudFormationTemplate {
  // CDK synthesizes JSON templates, and the AWS CLI's `--output json` embeds an
  // already-JSON TemplateBody as a parsed object rather than a further JSON string. A
  // YAML-authored stack (never produced by this repo, but a describable CloudFormation
  // state in general) would come back as a string instead, so both shapes are handled.
  if (typeof templateBody === "string") return JSON.parse(templateBody) as CloudFormationTemplate;
  if (typeof templateBody === "object" && templateBody !== null) {
    return templateBody as CloudFormationTemplate;
  }
  return {};
}

/**
 * Finds DynamoDB tables the foundation stack's *own stored template* still owns but that
 * `services/cdk/src/tables.ts` no longer defines — the mirror image of the GSI-drift case
 * deployment-purge-schema.ts fixed. Production hit this on 2026-09-16: SessionLogs was
 * retired from the catalog (docs/aws.md:618 — log bodies moved to S3) but the 2026-08-19
 * production stack still had the resource, with DeletionPolicy still Retain. Purge's
 * retarget synthesizes the *current* catalog, so its `cdk deploy` removed the SessionLogs
 * resource from the stack; CloudFormation's `DELETE_SKIPPED` (Retain) then orphaned the
 * live table — 954 items, deletion protection still enabled — and the later stack destroy
 * never saw it, since it was no longer stack-managed. Purge exited 0 and reported success
 * anyway.
 *
 * Deliberately NOT implemented as `aws dynamodb list-tables` filtered by
 * `${config.tablePrefix}-`: table prefixes are `AutoHarness-${environment}`, so environment
 * "prod" prefix-matches "AutoHarness-prod-extra-Sessions", a *different* environment's live
 * table (environment "prod-extra"). A prefix scan could misidentify and delete another
 * environment's data. `aws cloudformation get-template --template-stage Original` on *this*
 * foundation stack names only resources this one stack owns, which makes that
 * misattribution structurally impossible — no candidate this function considers can belong
 * to any other stack. This must run before retargetFoundationForDeletion: once that `cdk
 * deploy` completes, the "Original" stage reflects the *new* template, which no longer
 * mentions the dropped resource at all, so the orphan would already be invisible.
 *
 * A `TableName` that isn't a plain string (an intrinsic such as `{"Fn::Sub": ...}` or
 * `{"Ref": ...}`) is skipped rather than crashing purge — CDK always synthesizes a literal
 * string here today, so this is defensive, not expected — and is reported so an operator
 * knows purge could not evaluate that resource.
 */
export async function findOrphanedTableNames(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<string[]> {
  const stdout = await queryOk(
    dependencies,
    "aws",
    awsArgs(config, [
      "cloudformation",
      "get-template",
      "--stack-name",
      config.foundationStackName,
      "--template-stage",
      "Original",
      "--output",
      "json",
    ]),
  );
  const response = (stdout ? JSON.parse(stdout) : {}) as GetTemplateResponse;
  const resources = parseTemplateBody(response.TemplateBody).Resources ?? {};
  const catalogTableNames = new Set(
    DYNAMO_TABLES.map((table) => `${config.tablePrefix}-${table.name}`),
  );
  const storedTableNames: string[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::DynamoDB::Table") continue;
    const tableName = resource.Properties?.TableName;
    if (typeof tableName !== "string") {
      dependencies.log(
        `Skipping ${logicalId} in ${config.foundationStackName}: TableName is not a plain ` +
          `string (${JSON.stringify(tableName)}), cannot determine whether it is an orphan.`,
      );
      continue;
    }
    storedTableNames.push(tableName);
  }
  return storedTableNames.filter((tableName) => !catalogTableNames.has(tableName));
}

/**
 * Disables deletion protection on one orphan, tolerating the table already being gone.
 * A stored template's `DeletionPolicy` can be `Delete` rather than `Retain` (Retain is what
 * orphaned the production SessionLogs table; a different table could easily have the
 * opposite policy) — when it is, retargetFoundationForDeletion's own `cdk deploy` already
 * deleted this table as an ordinary stack update, before deleteOrphanedTables ever runs.
 * Routed through `dependencies.query` rather than `run`, mirroring inspectLiveTables in
 * deployment-purge-schema.ts, specifically so a `ResourceNotFoundException` can be told
 * apart from a real failure (AccessDenied, ResourceInUse, ...): the former means the
 * cleanup this function exists to do already happened, not that it failed.
 */
async function disableDeletionProtection(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  tableName: string,
): Promise<"already-gone" | "disabled"> {
  const result = await dependencies.query(
    "aws",
    awsArgs(config, [
      "dynamodb",
      "update-table",
      "--table-name",
      tableName,
      "--no-deletion-protection-enabled",
    ]),
  );
  if (result.status === 0) return "disabled";
  if (/ResourceNotFoundException/u.test(`${result.stderr}\n${result.stdout}`))
    return "already-gone";
  throw new Error(`unable to update ${tableName}: ${result.stderr || result.stdout}`);
}

/**
 * Actually removes each table findOrphanedTableNames identified. DynamoDB refuses
 * delete-table on a table with deletion protection enabled — the very setting that let the
 * production SessionLogs table survive its stack's destruction — so protection is disabled
 * first (see disableDeletionProtection). `update-table` briefly takes the table out of
 * ACTIVE, so this waits for it to settle back before issuing delete-table.
 *
 * Called only after the foundation stack itself is destroyed (see purge() in
 * deployment.ts), so a failure partway through this loop can never leave the stack
 * un-destroyable. Every table is attempted even if an earlier one fails — purge's whole
 * contract is destroying the environment, and the operator already typed
 * `destroy-all-data-in-<environment>` — and every failure is collected and thrown together
 * at the end, naming exactly the tables that are still alive, so purge can never exit 0
 * while any of them survive. This mirrors the existing post-destroy stack-state check in
 * runDeployment, which throws rather than reporting partial success.
 */
export async function deleteOrphanedTables(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  tableNames: readonly string[],
): Promise<void> {
  const survivingTableNames: string[] = [];
  for (const tableName of tableNames) {
    try {
      const state = await disableDeletionProtection(config, dependencies, tableName);
      if (state === "already-gone") {
        dependencies.log(
          `Orphaned table ${tableName} no longer exists — its own stack update already ` +
            "removed it (DeletionPolicy: Delete); nothing left to delete.",
        );
        continue;
      }
      await dependencies.run(
        "aws",
        awsArgs(config, ["dynamodb", "wait", "table-exists", "--table-name", tableName]),
      );
      await dependencies.run(
        "aws",
        awsArgs(config, ["dynamodb", "delete-table", "--table-name", tableName]),
      );
      dependencies.log(
        `Deleted orphaned DynamoDB table ${tableName} (retired from the catalog, but left ` +
          "behind by the foundation stack's stored template).",
      );
    } catch (error) {
      survivingTableNames.push(tableName);
      dependencies.log(
        `Failed to delete orphaned table ${tableName}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  if (survivingTableNames.length > 0) {
    throw new Error(
      `purge left ${String(survivingTableNames.length)} orphaned DynamoDB table(s) behind: ` +
        survivingTableNames.join(", "),
    );
  }
}
