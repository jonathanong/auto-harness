#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../src/cli.ts");
const require = createRequire(import.meta.url);
let tsxBin;
try {
  tsxBin = require.resolve("tsx/cli");
} catch {
  tsxBin = null;
}

if (tsxBin) {
  const result = spawnSync(process.execPath, [tsxBin, cli, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

console.error(
  "tsx is required to run auto-harness-agent from source. From repo root: pnpm install && pnpm local:agent -- <args>",
);
process.exit(1);
