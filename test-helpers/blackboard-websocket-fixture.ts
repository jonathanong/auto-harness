import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlPlane } from "../services/api/src/control-plane.ts";
import { startLocalServer } from "../services/api/src/local-server.ts";
import { runCommandOk } from "../scripts/lib/run-command.mts";

export async function git(path: string, args: string[]) {
  return (await runCommandOk("git", args, { cwd: path })).trim();
}

/** Creates two real commits so checkout assertions prove the requested feature ref. */
export async function setupFeatureRepository(repositoryPath: string): Promise<string> {
  mkdirSync(repositoryPath);
  for (const args of [
    ["init"],
    ["config", "user.email", "integration@example.test"],
    ["config", "user.name", "Integration"],
  ])
    await git(repositoryPath, args);
  writeFileSync(join(repositoryPath, "README"), "fixture\n");
  for (const args of [
    ["add", "."],
    ["commit", "-m", "initial"],
    ["branch", "-M", "main"],
    ["checkout", "-b", "feature/ws"],
  ])
    await git(repositoryPath, args);
  writeFileSync(join(repositoryPath, "feature"), "feature\n");
  await git(repositoryPath, ["add", "."]);
  await git(repositoryPath, ["commit", "-m", "feature"]);
  const featureSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
  await git(repositoryPath, ["checkout", "main"]);
  return featureSha;
}

/** Records actual hook context before an optional failure. */
export function writeTerminalHook(path: string, output: string, exitCode = 0): void {
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$HARNESS_SESSION_ID" "$HARNESS_STATUS" "$HARNESS_REF" "$HARNESS_WORKTREE_PATH" > "${output}"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
}

/** Binds a real HTTP/WebSocket controller listener, retrying only port collisions. */
export async function startWebsocketServer(plane: ControlPlane) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await startLocalServer({
        plane,
        port: 32_000 + Math.floor(Math.random() * 10_000),
        enableWs: true,
        authMode: "disabled",
        scheduler: { intervalMs: 25 },
      });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE"))
        throw error;
    }
  }
  throw new Error("cannot bind isolated WebSocket test listener");
}
