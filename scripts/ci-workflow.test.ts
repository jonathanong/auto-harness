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
  it("keeps the job IDs and display names exact", () => {
    const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n    name: ([^\n]+)$/gm)].map(
      ([, id, name]) => [id, name],
    );
    expect(jobs).toEqual([
      ["static-code-analysis", "static-code-analysis"],
      ["vitest-shard", "vitest-${{ matrix.shard }}"],
      ["vitest", "vitest"],
      ["playwright-e2e", "playwright-e2e"],
      ["playwright-auth", "playwright-auth"],
      ["playwright", "playwright"],
    ]);
  });

  it("keeps static analysis and Vitest responsibilities separated", () => {
    const staticAnalysis = job("static-code-analysis");
    expect(staticAnalysis).toContain("run: pnpm lint");
    expect(staticAnalysis).toContain("run: pnpm lint:ast");
    expect(staticAnalysis).toContain("run: pnpm fmt:check");
    expect(staticAnalysis).toContain("run: pnpm typecheck");
    expect(staticAnalysis).toContain("run: pnpm knip");
    expect(staticAnalysis).toContain("run: pnpm depcruise");
    expect(staticAnalysis).toContain("run: pnpm check:data-pw");
    expect(staticAnalysis).toContain("run: pnpm check:systemd");
    expect(staticAnalysis).toContain("uses: lycheeverse/lychee-action@v2");
    expect(staticAnalysis).not.toContain("run: pnpm test");

    const shard = job("vitest-shard");
    expect(shard).toContain("run: pnpm local:dynamodb:ready");
    expect(shard).toContain("run: pnpm test:shard");
    expect(shard).not.toContain("run: pnpm check:coverage:dynamo-adapters");
  });

  it("only enforces coverage thresholds once, on the merged shard result", () => {
    // Each shard only sees a partial subset of files, so thresholds must not be evaluated
    // there — only pnpm test:merge, after all shard blobs are downloaded and combined, is
    // the load-bearing coverage gate. No DynamoDB is needed to merge blobs.
    const fanIn = job("vitest");
    expect(fanIn).toContain("run: pnpm test:merge");
    expect(fanIn).toContain("run: pnpm check:coverage:dynamo-adapters");
    expect(fanIn).not.toContain("run: pnpm local:dynamodb:ready");
    expect(fanIn).not.toContain("services:\n      dynamodb:");
  });

  it("runs DynamoDB Local as a native services: container, not a docker compose step", () => {
    // Depends on the same amazon/dynamodb-local image staying pinned and port-mapped
    // consistently with DEFAULT_DYNAMODB_ENDPOINT (services/api/src/db/dynamo.ts).
    const contents = job("vitest-shard");
    expect(contents).toContain(
      "services:\n      dynamodb:\n        image: amazon/dynamodb-local:2.5.2",
    );
    expect(contents).toContain("- 7423:8000");
    expect(contents).not.toContain("name: Start DynamoDB Local");
    expect(contents).not.toContain("run: pnpm local:dynamodb &&");
  });

  it("shards vitest 2-way and uploads a distinctly-named coverage blob per shard", () => {
    const shard = job("vitest-shard");
    expect(shard).toContain("matrix:\n        shard: [1, 2]");
    expect(shard).toContain("--shard=${{ matrix.shard }}/2");
    expect(shard).toContain("--outputFile.blob=.vitest-reports/blob-${{ matrix.shard }}.json");
    expect(shard).toContain("name: vitest-blob-${{ matrix.shard }}");
  });

  it("fans vitest-shard and playwright-e2e/playwright-auth into required, always-run gates", () => {
    // Each fan-in job must run even when its dependency failed (if: always()) — otherwise
    // GitHub reports the required check as skipped rather than red, and a failure never
    // blocks the merge.
    const vitestFanIn = job("vitest");
    expect(vitestFanIn).toContain("needs: vitest-shard");
    expect(vitestFanIn).toContain("if: always()");
    expect(vitestFanIn).toContain("needs.vitest-shard.result != 'success'");

    const playwrightFanIn = job("playwright");
    expect(playwrightFanIn).toContain("needs: [playwright-e2e, playwright-auth]");
    expect(playwrightFanIn).toContain("if: always()");
    expect(playwrightFanIn).toContain("needs.playwright-e2e.result != 'success'");
    expect(playwrightFanIn).toContain("needs.playwright-auth.result != 'success'");
  });

  it("cleans, restores the Next.js cache, then builds, then tests, in the default E2E job", () => {
    const tests = job("playwright-e2e");
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
