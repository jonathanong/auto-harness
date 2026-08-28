import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const outputPath = new URL("../actions/dispatch/dist/index.js", import.meta.url);
const result = await build({
  bundle: true,
  entryPoints: [fileURLToPath(new URL("../actions/dispatch/src/index.ts", import.meta.url))],
  format: "esm",
  legalComments: "none",
  platform: "node",
  target: "node20",
  write: false,
});
const generated = result.outputFiles[0]?.text;
if (generated === undefined) throw new Error("esbuild did not produce the dispatch Action bundle");

if (process.argv.includes("--check")) {
  const committed = await readFile(outputPath, "utf8").catch(() => "");
  if (committed !== generated) {
    throw new Error("actions/dispatch/dist/index.js is stale; run pnpm build:dispatch-action");
  }
  process.stdout.write("dispatch Action bundle is current\n");
} else {
  await writeFile(outputPath, generated, "utf8");
  process.stdout.write("built actions/dispatch/dist/index.js\n");
}
