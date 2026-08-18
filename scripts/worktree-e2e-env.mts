/**
 * Give each git worktree its own e2e port range and DynamoDB container, so parallel agents
 * working in sibling worktrees never guess at a shared `HARNESS_E2E_PORT_OFFSET` and collide —
 * or, worse, silently succeed against someone else's stack. See docs/worktrees.md.
 *
 * The offset (and therefore every derived port) is a deterministic hash of the worktree's
 * directory name, not random or incrementing — the same worktree always gets the same ports
 * across runs, so its DynamoDB container and `.next-e2e` build stay reusable.
 *
 * Usage:
 *   node scripts/worktree-e2e-env.mts               # print `export KEY=value` lines
 *   node scripts/worktree-e2e-env.mts --ensure-db    # create/reuse this worktree's DynamoDB container
 *   node scripts/worktree-e2e-env.mts --run -- <playwright args>
 *                                                     # ensure the container, build web + host-pane
 *                                                     # e2e bundles with the matching HARNESS_API_HTTP
 *                                                     # baked in, then run Playwright with the
 *                                                     # isolated env — the sequence this file exists
 *                                                     # to stop anyone getting wrong by hand.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

/** FNV-1a, 32-bit. Deterministic, well-distributed, no external dependency. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Matches e2e/harness-endpoints.ts's own bound (HARNESS_E2E_PORT_OFFSET: 0 through 50000). */
const OFFSET_BUCKETS = 2000;

export type WorktreePorts = {
  slug: string;
  offset: number;
  apiPort: number;
  controlPort: number;
  hostPanePort: number;
  dynamoPort: number;
  containerName: string;
};

/**
 * `10 + bucket * 4` keeps every worktree's 4-port block (api/control/host-pane/dynamo) aligned
 * the same way the default 7430-7433 block is, and starts past offset 0 so an isolated worktree
 * run can never collide with the shared default stack (`pnpm test:e2e`'s own 743x range).
 */
export function computePorts(slug: string): WorktreePorts {
  const offset = 10 + (fnv1a(slug) % OFFSET_BUCKETS) * 4;
  return {
    slug,
    offset,
    apiPort: 7430 + offset,
    controlPort: 7431 + offset,
    hostPanePort: 7432 + offset,
    dynamoPort: 7433 + offset,
    containerName: `${slug}-dynamodb-e2e`,
  };
}

export function worktreeSlug(cwd: string = process.cwd()): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  const root = result.status === 0 ? result.stdout.trim() : cwd;
  return path.basename(root);
}

function envFor(ports: WorktreePorts): Record<string, string> {
  return {
    HARNESS_E2E_PORT_OFFSET: String(ports.offset),
    HARNESS_E2E_DDB_ENDPOINT: `http://127.0.0.1:${ports.dynamoPort}`,
    HARNESS_API_HTTP: `http://127.0.0.1:${ports.apiPort}`,
  };
}

function ensureDynamo(ports: WorktreePorts): void {
  const inspect = spawnSync("docker", ["inspect", ports.containerName], { stdio: "ignore" });
  if (inspect.status === 0) return; // Already exists — reused as-is, matching e2e's in-memory-DB reset-on-recreate contract.
  const run = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      ports.containerName,
      "-p",
      `${ports.dynamoPort}:8000`,
      "amazon/dynamodb-local:2.5.2",
      "-jar",
      "DynamoDBLocal.jar",
      "-sharedDb",
      "-inMemory",
    ],
    { stdio: "inherit" },
  );
  if (run.status !== 0) {
    console.error(
      `Failed to start ${ports.containerName} on port ${ports.dynamoPort} — is Docker running, and is that port free?`,
    );
    process.exit(1);
  }
}

function runIsolated(playwrightArgs: string[], ports: WorktreePorts): never {
  ensureDynamo(ports);
  const env = envFor(ports);
  const build = spawnSync("pnpm", ["build:web:e2e"], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_API_HTTP: env.HARNESS_API_HTTP },
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const test = spawnSync("pnpm", ["exec", "playwright", "test", ...playwrightArgs], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  process.exit(test.status ?? 1);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const ports = computePorts(worktreeSlug());
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "--ensure-db") {
    ensureDynamo(ports);
    console.log(ports.containerName);
  } else if (mode === "--run") {
    const dashIndex = rest.indexOf("--");
    runIsolated(dashIndex === -1 ? [] : rest.slice(dashIndex + 1), ports);
  } else {
    for (const [key, value] of Object.entries(envFor(ports))) {
      console.log(`export ${key}=${value}`);
    }
    console.log(`# DynamoDB container for this worktree: ${ports.containerName}`);
  }
}
