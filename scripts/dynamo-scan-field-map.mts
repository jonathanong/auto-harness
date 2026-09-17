import { tableNames } from "../services/api/src/db/dynamo.ts";

export type TableFieldMap = Record<string, string>;

/** Map every `DynamoTableNames` field to its bare (unprefixed) DynamoDB table name. */
export function fieldToTableMap(): TableFieldMap {
  const sentinel = "SCANCHECKSENTINEL";
  const map: TableFieldMap = {};
  for (const [field, value] of Object.entries(tableNames(sentinel))) {
    map[field] = value.slice(sentinel.length + 1);
  }
  return map;
}

/**
 * `ScannableTableField` (services/api/src/db/dynamo.ts) derives the set of tables a
 * parameterized Scan helper may be called with by capitalizing each `DynamoTableNames` field
 * name and checking membership in `SCAN_TABLE_NAMES` — that only proves what it claims to prove
 * if capitalizing a field name always yields its real bare table name. Assert the convention
 * against the actual field-to-table map here so a field that breaks it (e.g. an acronym-led
 * name whose bare table isn't just `Capitalize(field)`) fails loudly instead of silently
 * miscomputing that type-level allowlist.
 */
export function validateFieldCapitalization(fieldToTable: TableFieldMap): string[] {
  const errors: string[] = [];
  for (const [field, tableName] of Object.entries(fieldToTable)) {
    const expected = field.charAt(0).toUpperCase() + field.slice(1);
    if (tableName !== expected) {
      errors.push(
        `capitalization convention broken: field \`${field}\` maps to table \`${tableName}\`, ` +
          `but ScannableTableField assumes Capitalize(\`${field}\`) === \`${expected}\` — ` +
          `update services/api/src/db/dynamo.ts's ScannableTableField derivation`,
      );
    }
  }
  return errors;
}
