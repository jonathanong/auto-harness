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
  it("keeps the five required job IDs and display names exact", () => {
    const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: ([^\n]+)$/gm)].map(
      ([, id, name]) => [id, name],
    );
    expect(jobs).toEqual([
      ["static-code-analysis", "static-code-analysis"],
      ["vitest", "vitest"],
      ["integration", "integration"],
      ["playwright", "playwright"],
      ["playwright-auth", "playwright-auth"],
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
    expect(staticAnalysis).toContain("run: pnpm check:systemd");
    expect(staticAnalysis).toContain("uses: lycheeverse/lychee-action@v2");
    expect(staticAnalysis).not.toContain("run: pnpm test");

    const tests = job("vitest");
    expect(tests).toContain("run: pnpm local:dynamodb:ready");
    expect(tests).toContain("run: pnpm test");
    expect(tests).toContain("run: pnpm check:coverage:dynamo-adapters");

    const integration = job("integration");
    expect(integration).toContain("run: pnpm local:dynamodb:ready");
    expect(integration).toContain("run: pnpm test:integration");
  });

  it("runs DynamoDB Local as a native services: container, not a docker compose step", () => {
    // The two jobs above depend on the same amazon/dynamodb-local image staying pinned and
    // port-mapped consistently with DEFAULT_DYNAMODB_ENDPOINT (services/api/src/db/dynamo.ts).
    for (const id of ["vitest", "integration"]) {
      const contents = job(id);
      expect(contents).toContain(
        "services:\n      dynamodb:\n        image: amazon/dynamodb-local:2.5.2",
      );
      expect(contents).toContain("- 7423:8000");
      expect(contents).not.toContain("name: Start DynamoDB Local");
      expect(contents).not.toContain("run: pnpm local:dynamodb &&");
    }
  });

  it("cleans, restores the Next.js cache, then builds, then tests, in the default E2E job", () => {
    const tests = job("playwright");
    const steps = [
      "name: Clean e2e build output\n",
      "name: Cache Next.js build cache\n",
      "name: Build (e2e)\n",
      "name: Playwright E2E\n",
    ];
    for (const step of steps) expect(tests).toContain(step);
    for (let i = 1; i < steps.length; i++) {
      expect(tests.indexOf(steps[i - 1])).toBeLessThan(tests.indexOf(steps[i]));
    }
    expect(tests).toContain(
      "run: pnpm --filter @auto-harness/web build:e2e && pnpm --filter @auto-harness/host-pane build:e2e\n",
    );
    expect(tests).toContain("run: pnpm exec playwright test\n");
    expect(tests).toContain("name: playwright-report\n");
    expect(tests).toContain("playwright-report/");
    expect(tests).toContain("test-results/");
  });

  it("cleans, restores the Next.js cache, then builds, then tests, in the required-auth E2E job", () => {
    const tests = job("playwright-auth");
    const steps = [
      "name: Clean e2e build output\n",
      "name: Cache Next.js build cache\n",
      "name: Build (e2e, auth)\n",
      "name: Playwright E2E (required auth)\n",
    ];
    for (const step of steps) expect(tests).toContain(step);
    for (let i = 1; i < steps.length; i++) {
      expect(tests.indexOf(steps[i - 1])).toBeLessThan(tests.indexOf(steps[i]));
    }
    expect(tests).toContain("run: pnpm --filter @auto-harness/web build:e2e\n");
    expect(tests).toContain(
      "run: pnpm exec playwright test e2e/control/auth.spec.ts e2e/control/service-accounts.spec.ts e2e/control/user-accounts.spec.ts --project=control\n",
    );
    expect(tests).toContain("name: playwright-report-auth\n");
    expect(tests).toContain("playwright-report/");
    expect(tests).toContain("test-results/");
  });
});
