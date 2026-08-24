/**
 * Give each git worktree its own e2e port range and DynamoDB container, so parallel agents
 * working in sibling worktrees never guess at a shared `HARNESS_E2E_PORT_OFFSET` and collide —
 * or, worse, silently succeed against someone else's stack. See docs/e2e.md.
 *
 * The starting port block is a deterministic hash of the worktree's directory name, not random
 * or incrementing — the same worktree gets the same starting block across runs, so its DynamoDB
 * container and `.next-e2e` build stay reusable. Two worktree names can still hash to the same
 * starting block (2000 buckets is not a birthday-paradox-safe space once dozens of worktrees
 * exist), so every real invocation probes the candidate ports and walks forward to the next
 * block on a genuine collision — see `findAvailablePorts`.
 *
 * Usage:
 *   node scripts/worktree-e2e-env.mts               # print `export KEY=value` lines
 *   node scripts/worktree-e2e-env.mts --ensure-db    # create/reuse/restart this worktree's DynamoDB container
 *   node scripts/worktree-e2e-env.mts --run -- <playwright args>
 *                                                     # ensure the container, build web + host-pane
 *                                                     # e2e bundles with the matching HARNESS_API_HTTP
 *                                                     # baked in, then run Playwright with the
 *                                                     # isolated env — the sequence this file exists
 *                                                     # to stop anyone getting wrong by hand.
 */
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
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

export function bucketFor(slug: string): number {
  return fnv1a(slug) % OFFSET_BUCKETS;
}

/**
 * `10 + bucket * 4` keeps every worktree's 4-port block (api/control/host-pane/dynamo) aligned
 * the same way the default 7430-7433 block is, and starts past offset 0 so an isolated worktree
 * run can never collide with the shared default stack (`pnpm test:e2e`'s own 743x range).
 */
export function portsForBucket(slug: string, bucket: number): WorktreePorts {
  const offset = 10 + (bucket % OFFSET_BUCKETS) * 4;
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

/** The deterministic starting candidate for `slug` — see `findAvailablePorts` for collision handling. */
export function computePorts(slug: string): WorktreePorts {
  return portsForBucket(slug, bucketFor(slug));
}

export function worktreeSlug(cwd: string = process.cwd()): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  const root = result.status === 0 ? result.stdout.trim() : cwd;
  return path.basename(root);
}

export function envFor(ports: WorktreePorts): Record<string, string> {
  return {
    HARNESS_E2E_PORT_OFFSET: String(ports.offset),
    HARNESS_E2E_DDB_ENDPOINT: `http://127.0.0.1:${ports.dynamoPort}`,
    HARNESS_API_HTTP: `http://127.0.0.1:${ports.apiPort}`,
    HARNESS_PUBLIC_BASE_URL: `http://127.0.0.1:${ports.controlPort}`,
  };
}

/** Whether something is listening on 127.0.0.1:port right now. */
function isPortOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 300 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

const DYNAMODB_IMAGE = "amazon/dynamodb-local:3.3.1";

type ContainerInspection = {
  state: "running" | "stopped";
  image: string;
};

function inspectContainer(name: string): ContainerInspection | undefined {
  const inspect = spawnSync(
    "docker",
    ["inspect", "-f", "{{.State.Running}}\t{{.Config.Image}}", name],
    { encoding: "utf8" },
  );
  if (inspect.status !== 0) return undefined;
  const [running, image = ""] = inspect.stdout.trim().split("\t");
  return { state: running === "true" ? "running" : "stopped", image };
}

/**
 * Walk forward from this worktree's hash-seeded bucket until every one of the 4 ports is
 * either free, or (for the DynamoDB port only) already bound to this exact worktree's own
 * container — reusing that container is the whole point, not a collision. A port genuinely
 * occupied by anything else (another worktree that landed on the same bucket, or a leftover
 * process) means this candidate block is unusable; try the next one.
 */
export async function findAvailablePorts(
  slug: string,
  maxAttempts = OFFSET_BUCKETS,
): Promise<WorktreePorts> {
  let bucket = bucketFor(slug);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ports = portsForBucket(slug, bucket);
    const dynamoIsOurs = inspectContainer(ports.containerName) !== undefined;
    const [dynamoFree, apiFree, controlFree, hostPaneFree] = await Promise.all([
      dynamoIsOurs ? Promise.resolve(true) : isPortOccupied(ports.dynamoPort).then((b) => !b),
      isPortOccupied(ports.apiPort).then((b) => !b),
      isPortOccupied(ports.controlPort).then((b) => !b),
      isPortOccupied(ports.hostPanePort).then((b) => !b),
    ]);
    if (dynamoFree && apiFree && controlFree && hostPaneFree) return ports;
    bucket = (bucket + 1) % OFFSET_BUCKETS;
  }
  throw new Error(
    `Could not find a free e2e port block for worktree "${slug}" — every candidate is occupied.`,
  );
}

export function ensureDynamo(ports: WorktreePorts): void {
  const existing = inspectContainer(ports.containerName);
  if (existing?.image === DYNAMODB_IMAGE && existing.state === "running") return;
  if (existing?.image === DYNAMODB_IMAGE) {
    const start = spawnSync("docker", ["start", ports.containerName], { stdio: "inherit" });
    if (start.status !== 0) {
      console.error(`Failed to restart stopped container ${ports.containerName}.`);
      process.exit(1);
    }
    return;
  }
  if (existing !== undefined) {
    const remove = spawnSync("docker", ["rm", "-f", ports.containerName], { stdio: "inherit" });
    if (remove.status !== 0) {
      console.error(`Failed to recreate outdated container ${ports.containerName}.`);
      process.exit(1);
    }
  }
  const run = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      ports.containerName,
      "-p",
      `${ports.dynamoPort}:8000`,
      DYNAMODB_IMAGE,
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
  const ports = await findAvailablePorts(worktreeSlug());
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
