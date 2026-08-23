import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const rootPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

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
      ["vitest-platform", "vitest-${{ matrix.name }}"],
      ["vitest", "vitest"],
      ["playwright-build", "playwright-build"],
      ["playwright-e2e", "playwright-e2e-${{ matrix.shard }}"],
      ["playwright-auth", "playwright-auth"],
      ["playwright", "playwright"],
    ]);
  });

  it("keeps static analysis and Vitest responsibilities separated", () => {
    const staticAnalysis = job("static-code-analysis");
    expect(staticAnalysis).toContain("run: pnpm lint");
    expect(staticAnalysis).toContain("run: pnpm lint:ast");
    expect(staticAnalysis).toContain("run: pnpm fmt:check");
    expect(staticAnalysis).toContain("name: Cache tsc incremental\n");
    expect(staticAnalysis).toContain("modules/*/tsconfig.tsbuildinfo");
    expect(staticAnalysis).toContain("services/*/tsconfig.tsbuildinfo");
    expect(staticAnalysis.indexOf("name: Cache tsc incremental\n")).toBeLessThan(
      staticAnalysis.indexOf("pnpm --dir modules/shared exec tsc --noEmit"),
    );
    expect(staticAnalysis).toContain("pnpm --dir modules/shared exec tsc --noEmit");
    expect(staticAnalysis).toContain("pnpm --dir services/api exec tsc --noEmit");
    expect(staticAnalysis).toContain("run: pnpm knip");
    expect(staticAnalysis).toContain("run: pnpm depcruise");
    expect(staticAnalysis).toContain("run: pnpm check:no-mistakes");
    expect(staticAnalysis).toContain("run: pnpm check:systemd");
    expect(staticAnalysis).toContain(
      "uses: lycheeverse/lychee-action@e7477775783ea5526144ba13e8db5eec57747ce8 # v2",
    );
    expect(staticAnalysis).not.toContain("run: pnpm test");

    const shard = job("vitest-shard");
    expect(shard).toContain("run: pnpm local:dynamodb:ready");
    expect(shard).toContain("run: pnpm test:shard");
    expect(shard).toContain("VITEST_PATCH_COVERAGE_PATH:");
    expect(shard).toContain("name: vitest-patch-${{ matrix.shard }}");
    expect(shard).not.toContain("run: pnpm check:coverage:dynamo-adapters");
  });

  it("only enforces coverage thresholds once, on the merged shard result", () => {
    // Each shard only sees a partial subset of files, so thresholds must not be evaluated
    // there — only pnpm test:merge, after all shard blobs are downloaded and combined, is
    // the load-bearing coverage gate. No DynamoDB is needed to merge blobs.
    const fanIn = job("vitest");
    expect(fanIn).toContain("run: pnpm test:merge");
    expect(fanIn).toContain("name: Download supplemental patch coverage");
    expect(fanIn).toContain("pattern: vitest-patch-*");
    expect(fanIn).toContain("run: pnpm check:coverage:patch");
    expect(fanIn).toContain("COVERAGE_BASE_SHA:");
    expect(fanIn).toContain("fetch-depth: 0");
    expect(fanIn).toContain("run: pnpm check:coverage:dynamo-adapters");
    expect(fanIn).not.toContain("run: pnpm local:dynamodb:ready");
    expect(fanIn).not.toContain("services:\n      dynamodb:");
    expect(fanIn.indexOf("run: pnpm test:merge")).toBeLessThan(
      fanIn.indexOf("name: Download supplemental patch coverage"),
    );
    expect(fanIn.indexOf("name: Download supplemental patch coverage")).toBeLessThan(
      fanIn.indexOf("run: pnpm check:coverage:patch"),
    );
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
    expect(shard).toContain("path: coverage/patch-${{ matrix.shard }}.lcov");
  });

  it("runs only the focused native test command on macOS and Windows", () => {
    const platform = job("vitest-platform");
    expect(platform).toContain("name: vitest-${{ matrix.name }}");
    expect(platform).toContain("fail-fast: false");
    expect(platform).toContain("name: macos\n            runner: macos-latest");
    expect(platform).toContain("name: windows\n            runner: windows-latest");
    expect(platform).toContain("run: pnpm install --frozen-lockfile --ignore-scripts");
    expect(platform).toContain("run: pnpm prepare:test:platform");
    expect(platform).toContain("run: pnpm test:platform");
    expect(platform).not.toContain("run: pnpm test\n");
    expect(platform).not.toContain("run: pnpm local:dynamodb:ready");
    expect(platform).not.toContain("--coverage");
    expect(rootPackage.scripts["prepare:test:platform"]).toBe(
      "node services/host-daemon/node_modules/node-pty/scripts/prebuild.js && node services/host-daemon/node_modules/node-pty/scripts/post-install.js",
    );
    expect(rootPackage.scripts["test:platform"]).toBe(
      "vitest run services/host-daemon/src/pty-runner.real.test.ts services/host-daemon/src/executor.test.ts services/host-daemon/src/git.real.test.ts services/host-daemon/src/host-service-io.test.ts integration/echo-orchestration.test.ts",
    );
  });

  it("fans test jobs into required, always-run gates", () => {
    // Each fan-in job must run even when its dependency failed (if: always()) — otherwise
    // GitHub reports the required check as skipped rather than red, and a failure never
    // blocks the merge.
    const vitestFanIn = job("vitest");
    expect(vitestFanIn).toContain("needs: [vitest-shard, vitest-platform]");
    expect(vitestFanIn).toContain("if: always()");
    expect(vitestFanIn).toContain("needs.vitest-shard.result != 'success'");
    expect(vitestFanIn).toContain("needs.vitest-platform.result != 'success'");

    const playwrightFanIn = job("playwright");
    expect(playwrightFanIn).toContain("needs: [playwright-e2e, playwright-auth]");
    expect(playwrightFanIn).toContain("if: always()");
    expect(playwrightFanIn).toContain("needs.playwright-e2e.result != 'success'");
    expect(playwrightFanIn).toContain("needs.playwright-auth.result != 'success'");
  });

  it("builds and packages each Next.js E2E runtime once", () => {
    const build = job("playwright-build");
    expect(build).toContain("HARNESS_API_HTTP: http://127.0.0.1:7430");
    expect(build).toContain("id: control-runtime-cache");
    expect(build).toContain("id: host-pane-runtime-cache");
    expect(build).toContain(
      "nextjs-runtime-control-${{ runner.os }}-${{ runner.arch }}-api7430-v1-",
    );
    expect(build).toContain(
      "nextjs-runtime-host-pane-${{ runner.os }}-${{ runner.arch }}-api7430-v1-",
    );
    expect(build).toContain("path: services/web/.next-e2e/cache");
    expect(build).toContain("path: services/host-pane/.next-e2e/cache");
    expect(build).toContain("run: pnpm install --frozen-lockfile --ignore-scripts");
    expect(build).toContain(
      "run: pnpm --parallel --filter @auto-harness/web --filter @auto-harness/host-pane run build:e2e",
    );
    expect(build).toContain("--exclude='services/web/.next-e2e/cache'");
    expect(build).toContain("--exclude='services/host-pane/.next-e2e/cache'");
    expect(build).toContain("name: playwright-next-build");
    expect(build).toContain("compression-level: 0");
    expect(build.indexOf("name: Cache control E2E runtime archive\n")).toBeLessThan(
      build.indexOf("name: Build both E2E apps\n"),
    );
    expect(build.indexOf("name: Build both E2E apps\n")).toBeLessThan(
      build.indexOf("name: Upload E2E runtime\n"),
    );
  });

  it("fans the default E2E suite across two artifact-consuming shards", () => {
    const tests = job("playwright-e2e");
    expect(tests).toContain("name: playwright-e2e-${{ matrix.shard }}");
    expect(tests).toContain("needs: playwright-build");
    expect(tests).toContain("fail-fast: false");
    expect(tests).toContain("matrix:\n        shard: [1, 2]");
    expect(tests).toContain("name: playwright-next-build");
    expect(tests).toContain("control-next-e2e.tgz");
    expect(tests).toContain("host-pane-next-e2e.tgz");
    expect(tests).toContain("run: pnpm exec playwright test --shard=${{ matrix.shard }}/2");
    expect(tests).toContain("name: playwright-report-${{ matrix.shard }}");
    expect(tests).toContain("playwright-report/");
    expect(tests).toContain("test-results/");
    expect(tests).not.toContain("build:e2e");
    expect(tests).not.toContain(".next-e2e/cache");
  });

  it("runs required-auth E2E against the canonical control runtime", () => {
    const tests = job("playwright-auth");
    expect(tests).toContain("needs: playwright-build");
    expect(tests).toContain("HARNESS_AUTH_MODE: required");
    expect(tests).toContain("name: playwright-next-build");
    expect(tests).toContain("name: Extract control E2E runtime");
    expect(tests).toContain("control-next-e2e.tgz");
    expect(tests).toContain(
      "run: pnpm exec playwright test e2e/control/auth.spec.ts e2e/control/service-accounts.spec.ts e2e/control/user-accounts.spec.ts --project=control\n",
    );
    expect(tests).toContain("name: playwright-report-auth\n");
    expect(tests).toContain("playwright-report/");
    expect(tests).toContain("test-results/");
    expect(tests).not.toContain("build:e2e");
    expect(tests).not.toContain(".next-e2e/cache");
  });
});
