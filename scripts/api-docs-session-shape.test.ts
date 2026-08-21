import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const apiDocs = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8");
const sessionRecord = readFileSync(
  new URL("../services/api/src/db/types.ts", import.meta.url),
  "utf8",
);

describe("session API docs match PublicSession", () => {
  it("documents plural targetLabels and resolvedRoute, not a singular targetLabel field", () => {
    expect(apiDocs).toContain('"targetLabels"');
    expect(apiDocs).not.toMatch(/"targetLabel"\s*:/);
    expect(apiDocs).not.toMatch(/`targetLabel`/);
    expect(apiDocs).toContain('"target": { "providerId"');
    expect(apiDocs).toContain("providerAccountId");
    expect(apiDocs).toContain("resolvedRoute");
    expect(apiDocs).toMatch(/resolvedRoute[\s\S]*providerAccountId/);
  });

  it("keeps SessionRecord as the runtime source of those fields", () => {
    expect(sessionRecord).toMatch(/targetLabels:\s*string\[\]/);
    expect(sessionRecord).toMatch(/resolvedRoute\?:/);
    expect(sessionRecord).toMatch(/providerAccountId\?:\s*string/);
    expect(sessionRecord).not.toMatch(/^\s*targetLabel\?:/m);
  });
});
