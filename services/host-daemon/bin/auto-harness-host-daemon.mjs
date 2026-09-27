#!/usr/bin/env node
/**
 * Thin launcher: run agent CLI via Node native type stripping (no tsc/tsx build).
 * Requires Node.js >= 24 (workspace runtime and native type stripping).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../src/cli.ts");

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(`auto-harness-host-daemon requires Node.js >= 24 (got ${process.version})`);
  process.exit(1);
}

// Run the CLI in this process so service-manager signals reach the daemon's
// SIGINT/SIGTERM drain handlers. A child-process wrapper would make this
// launcher systemd's MainPID while the actual daemon ran behind it.
const { main } = await import(cli);
void main([process.execPath, cli, ...process.argv.slice(2)]).then((code) => {
  process.exitCode = code;
});
