#!/usr/bin/env node
/**
 * Dev entry: run with Node 22+ TypeScript strip-types against src.
 * Production images should point at compiled dist/cli.js.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cliTs = join(here, "../src/cli.ts");
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", cliTs, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
