import { describe, expect, it } from "vitest";

import {
  AGGREGATE_COVERAGE_EXCLUDE,
  COVERAGE_INCLUDE,
  coverageDisposition,
  executableLineNumbers,
  PATCH_COVERAGE_EXCLUDE,
} from "./coverage-scope.mts";

describe("coverage scope", () => {
  it("keeps aggregate, supplemental, and ignored paths explicit", () => {
    expect(coverageDisposition("modules/shared/src/constants.ts")).toBe("aggregate");
    expect(coverageDisposition("services/api/src/db/plane-storage-auth.ts")).toBe("supplemental");
    expect(coverageDisposition("services/api/src/create-plane.ts")).toBe("supplemental");
    expect(coverageDisposition("services/web/src/lib/api.ts")).toBe("supplemental");
    expect(coverageDisposition("services/api/src/new-types.ts")).toBe("supplemental");
    expect(coverageDisposition("services/api/src/example.test.ts")).toBe("ignored");
    expect(coverageDisposition("services/api/src/globals.d.ts")).toBe("ignored");
    expect(coverageDisposition("services/api/src/cli.ts")).toBe("ignored");
    expect(coverageDisposition("modules/ui/src/index.ts")).toBe("ignored");
    expect(coverageDisposition("services/host-pane/src/index.ts")).toBe("ignored");
    expect(coverageDisposition("docs/coverage.md")).toBe("ignored");
  });

  it("derives the aggregate and patch producer globs from the same scope", () => {
    expect(COVERAGE_INCLUDE).toEqual([
      "modules/*/src/**/*.{ts,tsx}",
      "services/*/src/**/*.{ts,tsx}",
    ]);
    expect(AGGREGATE_COVERAGE_EXCLUDE).toContain("**/db/plane-storage-auth.ts");
    expect(PATCH_COVERAGE_EXCLUDE).not.toContain("**/db/plane-storage-auth.ts");
    expect(AGGREGATE_COVERAGE_EXCLUDE).toContain("**/*-types.ts");
    expect(PATCH_COVERAGE_EXCLUDE).not.toContain("**/*-types.ts");
    expect(PATCH_COVERAGE_EXCLUDE).toContain("services/{api,cdk}/src/cli.ts");
  });
});

describe("executableLineNumbers", () => {
  it("omits comments and type-only syntax", () => {
    const source = [
      "import type { Principal } from './auth-types.ts';",
      "export type Result = { principal: Principal };",
      "// Runtime behavior starts below.",
      "export const enabled = true;",
    ].join("\n");
    expect([...executableLineNumbers(source, "services/api/src/example.ts")]).toEqual([4]);
  });

  it("returns no lines for a pure type-only module", () => {
    const source = [
      "export interface Example {",
      "  id: string;",
      "}",
      "export type Identifier = Example['id'];",
    ].join("\n");
    expect(executableLineNumbers(source, "services/api/src/example-types.ts")).toEqual(new Set());
  });

  it("supports TSX runtime lines", () => {
    const source = [
      "export type Props = { label: string };",
      "export function Badge({ label }: Props) {",
      "  return <span>{label}</span>;",
      "}",
    ].join("\n");
    expect([...executableLineNumbers(source, "modules/ui/src/components/badge.tsx")]).toEqual([
      2, 3, 4,
    ]);
  });
});
