import { readFileSync } from "node:fs";

import type { AgentConfig } from "../../services/agent/src/config.ts";
import { SpawnProcessRunner } from "../../services/agent/src/executor.ts";
import { createGitClient } from "../../services/agent/src/git.ts";
import { SessionRunner } from "../../services/agent/src/session-runner.ts";
import { WorktreeManager } from "../../services/agent/src/worktree-manager.ts";
import { createLocalApp } from "../../services/api/src/local-server.ts";
import { MemorySessionStore } from "../../services/api/src/memory-store.ts";
import { revParse } from "./git.mts";
import type { LocalE2ePaths } from "./setup.mts";

const CREATE_BODY = {
  repositoryId: "demo",
  prompt: "hello-from-e2e",
  commandProfile: "echo-prompt",
  timeout: 30,
  ref: "feature/local-e2e",
  requiredLabels: ["echo"],
};

export async function createSessionViaApi(): Promise<{
  id: string;
  status: string;
  url: string;
  commandProfile: string;
  ref?: string;
}> {
  const store = new MemorySessionStore({
    publicBaseUrl: "http://localhost:7421",
    idFactory: () => "sess-e2e",
    now: () => new Date().toISOString(),
  });
  const { handler } = createLocalApp({ store });
  let createStatus = 0;
  let createJson = "";
  const req = {
    method: "POST",
    url: "/api/v1/sessions",
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "data") {
        cb(Buffer.from(JSON.stringify(CREATE_BODY)));
      }
      if (event === "end") {
        cb();
      }
      return req;
    },
  };
  const res = {
    writeHead(code: number) {
      createStatus = code;
    },
    end(payload: string) {
      createJson = payload;
    },
  };
  await handler(req as never, res as never);
  if (createStatus !== 201) {
    throw new Error(`API create failed: ${createStatus} ${createJson}`);
  }
  const created = JSON.parse(createJson) as {
    id: string;
    status: string;
    url: string;
    commandProfile: string;
    ref?: string;
  };
  if (created.status !== "queued" || !created.url.includes(created.id)) {
    throw new Error(`unexpected create body: ${createJson}`);
  }
  return created;
}

export async function assertUnknownProfileFails(config: AgentConfig): Promise<void> {
  const runner = new SpawnProcessRunner();
  const gitClient = createGitClient(runner);
  const worktrees = new WorktreeManager(config, gitClient);
  await worktrees.ensureAll();
  const sessionRunner = new SessionRunner({
    config,
    worktrees,
    processRunner: runner,
  });
  const bad = await sessionRunner.run({
    sessionId: "sess-bad-profile",
    repositoryId: "demo",
    prompt: "x",
    commandProfile: "does-not-exist",
    timeout: 30,
    worktreeId: "wt-1",
    ref: "feature/local-e2e",
  });
  if (bad.status !== "failed" || bad.errorCode !== "unknown_command_profile") {
    throw new Error(`expected unknown_command_profile, got ${JSON.stringify(bad)}`);
  }
}

export async function runHappyPath(
  config: AgentConfig,
  paths: LocalE2ePaths,
  created: { id: string },
  featureSha: string,
): Promise<void> {
  const processRunner = new SpawnProcessRunner();
  const gitClient = createGitClient(processRunner);
  const worktrees = new WorktreeManager(config, gitClient);
  await worktrees.ensureAll();
  const sessionRunner = new SessionRunner({
    config,
    worktrees,
    processRunner,
  });
  const result = await sessionRunner.run({
    sessionId: created.id,
    repositoryId: "demo",
    prompt: CREATE_BODY.prompt,
    commandProfile: CREATE_BODY.commandProfile,
    timeout: CREATE_BODY.timeout,
    worktreeId: "wt-1",
    ref: "feature/local-e2e",
  });

  if (result.status !== "completed") {
    throw new Error(`session did not complete: ${JSON.stringify(result)}`);
  }

  const head = await revParse(paths.wtPath, "HEAD");
  if (head !== featureSha) {
    throw new Error(`worktree HEAD ${head} != feature sha ${featureSha} (ref checkout failed)`);
  }

  const hookOut = readFileSync(paths.hookLog, "utf8");
  if (!hookOut.includes(created.id) || !hookOut.includes("completed")) {
    throw new Error(`terminal hook missing env: ${hookOut}`);
  }

  const seqs = result.logs.map((l) => l.seq);
  for (let i = 1; i < seqs.length; i++) {
    if ((seqs[i] ?? 0) <= (seqs[i - 1] ?? 0)) {
      throw new Error(`log seq not monotonic: ${seqs.join(",")}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        sessionId: created.id,
        status: result.status,
        head,
        featureSha,
        logCount: result.logs.length,
        hook: hookOut.trim(),
      },
      null,
      2,
    ),
  );
}
