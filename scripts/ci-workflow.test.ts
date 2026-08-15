import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function job(id: string): string {
  const starts = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)];
  const index = starts.findIndex((match) => match[1] === id);
  const start = starts[index]?.index;
  if (start === undefined) throw new Error(`Missing CI job: ${id}`);
  const end = starts[index + 1]?.index ?? workflow.length;
  return workflow.slice(start, end);
}

describe("required CI check contract", () => {
  it("keeps the four required job IDs and display names exact", () => {
    const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: ([^\n]+)$/gm)].map(
      ([, id, name]) => [id, name],
    );
    expect(jobs).toEqual([
      ["static-code-analysis", "static-code-analysis"],
      ["vitest", "vitest"],
      ["integration", "integration"],
      ["playwright", "playwright"],
    ]);
  });

  it("keeps static analysis and Vitest responsibilities separated", () => {
    const staticAnalysis = job("static-code-analysis");
    expect(staticAnalysis).toContain("run: pnpm lint");
    expect(staticAnalysis).toContain("run: pnpm lint:ast");
    expect(staticAnalysis).toContain("run: pnpm fmt:check");
    expect(staticAnalysis).toContain("run: pnpm knip");
    expect(staticAnalysis).toContain("run: pnpm depcruise");
    expect(staticAnalysis).toContain("run: pnpm check:data-pw");
    expect(staticAnalysis).toContain("uses: lycheeverse/lychee-action@v2");
    expect(staticAnalysis).not.toContain("run: pnpm test");

    const tests = job("vitest");
    expect(tests).toContain("run: pnpm local:dynamodb && pnpm local:dynamodb:ready");
    expect(tests).toContain("run: pnpm test");
    expect(tests).toContain("run: pnpm check:coverage:dynamo-adapters");

    const integration = job("integration");
    expect(integration).toContain("run: pnpm local:dynamodb && pnpm local:dynamodb:ready");
    expect(integration).toContain("run: pnpm test:integration");
  });

  it("runs default and required-auth production E2E in the stable Playwright job", () => {
    const tests = job("playwright");
    expect(tests).toContain("name: Playwright E2E\n");
    expect(tests).toContain("run: pnpm test:e2e\n");
    expect(tests).toContain("name: Playwright E2E (required auth)\n");
    expect(tests).toContain("run: pnpm test:e2e:auth\n");
    expect(tests.indexOf("run: pnpm test:e2e\n")).toBeLessThan(
      tests.indexOf("run: pnpm test:e2e:auth\n"),
    );
    expect(tests).toContain("name: playwright-report");
    expect(tests).toContain("playwright-report/");
    expect(tests).toContain("test-results/");
  });
});
