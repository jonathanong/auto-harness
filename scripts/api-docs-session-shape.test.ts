import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const apiDocs = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8");
const sessionRecord = readFileSync(
  new URL("../services/api/src/db/types.ts", import.meta.url),
  "utf8",
);

function jsonExampleAfter(heading: string): Record<string, unknown> {
  const start = apiDocs.indexOf(heading);
  expect(start, heading).toBeGreaterThan(-1);
  const fence = apiDocs.indexOf("```json", start);
  expect(fence, `${heading} json fence`).toBeGreaterThan(-1);
  const bodyStart = apiDocs.indexOf("\n", fence) + 1;
  const bodyEnd = apiDocs.indexOf("```", bodyStart);
  return JSON.parse(apiDocs.slice(bodyStart, bodyEnd)) as Record<string, unknown>;
}

describe("session API docs match PublicSession", () => {
  it("documents GET /sessions/:id with targetDisplayNames and nested resolvedRoute", () => {
    const detail = jsonExampleAfter("#### `GET /sessions/:id`");
    expect(detail.targetDisplayNames).toEqual(["codex", "echo"]);
    expect(detail).not.toHaveProperty("targetLabels");
    expect(detail).not.toHaveProperty("targetLabel");
    expect(detail).not.toHaveProperty("providerId");
    expect(detail).not.toHaveProperty("providerAccountId");
    expect(detail.target).toEqual({ providerId: "prov-codex" });
    const route = detail.resolvedRoute as Record<string, unknown>;
    expect(route.providerAccountId).toBe("acct-codex-1");
    expect(route.commandId).toBe("cmd-codex-fix");
    expect(apiDocs).not.toMatch(/"targetLabel"\s*:/);
  });

  it("keeps SessionRecord as the runtime source of those fields", () => {
    expect(sessionRecord).toMatch(/targetDisplayNames:\s*string\[\]/);
    expect(sessionRecord).not.toMatch(/targetLabels:\s*string\[\]/);
    expect(sessionRecord).toMatch(/resolvedRoute\?:/);
    expect(sessionRecord).toMatch(/providerAccountId\?:\s*string/);
    expect(sessionRecord).not.toMatch(/^\s*targetLabel\?:/m);
  });
});
