#!/usr/bin/env node
/**
 * Thin launcher: run agent CLI via Node native type stripping (no tsc/tsx build).
 * Requires Node.js >= 22.18 (type stripping enabled by default).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../src/cli.ts");

const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1]);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `auto-harness-agent requires Node.js >= 22.18 for native TypeScript type stripping (got ${process.version})`,
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
