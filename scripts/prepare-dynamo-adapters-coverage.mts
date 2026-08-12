import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const workspaceKey = createHash("sha256").update(process.cwd()).digest("hex");
const runMarker = resolve(tmpdir(), `auto-harness-dynamo-coverage-${workspaceKey}.txt`);

rmSync(resolve("coverage", "coverage-summary.json"), { force: true });
writeFileSync(runMarker, String(Date.now()));
