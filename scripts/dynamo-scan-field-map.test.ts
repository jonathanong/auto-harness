import { describe, expect, it } from "vitest";

import { fieldToTableMap, validateFieldCapitalization } from "./dynamo-scan-field-map.mts";

describe("fieldToTableMap", () => {
  it("strips the sentinel prefix to recover bare DynamoDB table names", () => {
    const map = fieldToTableMap();
    expect(map.schedules).toBe("Schedules");
    expect(map.workspacePools).toBe("WorkspacePools");
    expect(map.hostLocks).toBe("HostLocks");
  });
});

describe("validateFieldCapitalization", () => {
  it("accepts a field-to-table map that follows the capitalize-first-letter convention", () => {
    expect(validateFieldCapitalization({ schedules: "Schedules", hostLocks: "HostLocks" })).toEqual(
      [],
    );
  });

  it("rejects a field whose bare table name isn't Capitalize(field) — the assumption ScannableTableField relies on", () => {
    expect(validateFieldCapitalization({ githubIngress: "GitHubIngress" })).toEqual([
      expect.stringContaining("capitalization convention broken: field `githubIngress`"),
    ]);
  });

  it("holds for the real DynamoTableNames field-to-table map (services/api/src/db/dynamo.ts's ScannableTableField depends on it)", () => {
    expect(validateFieldCapitalization(fieldToTableMap())).toEqual([]);
  });
});
