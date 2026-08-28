import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const actionSource = ["index.ts", "io.ts", "validation.ts"]
  .map((name) => readFileSync(new URL(`../actions/dispatch/src/${name}`, import.meta.url), "utf8"))
  .join("\n");

describe("dispatch Action static analysis", () => {
  it("typechecks the workspace and verifies its committed bundle in CI", () => {
    expect(workflow).toContain("actions/*/tsconfig.tsbuildinfo");
    expect(workflow).toContain("pnpm --dir actions/dispatch exec tsc --noEmit");
    expect(workflow).toContain("name: Verify dispatch Action bundle");
    expect(workflow).toContain("run: pnpm check:dispatch-action");
  });

  it("delegates HTTP and target resolution to auto-harness-client", () => {
    expect(actionSource).toMatch(/from "auto-harness-client"/);
    expect(actionSource).not.toMatch(/\bfetch\s*\(/);
  });
});
