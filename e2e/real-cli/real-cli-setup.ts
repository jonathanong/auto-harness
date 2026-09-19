import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";

import { runCommandOk } from "../../scripts/lib/run-command.mts";
import { API_BASE } from "../harness-endpoints.ts";

export const API = API_BASE;

export const REAL_CLI_PROMPT =
  "Reply with exactly: hello world. Do not use any tools. Do not read, create, or modify any files.";

/** `spawnSync("which", ...)` presence check — used for `test.skip()`, not an async describe-time check. */
export function hasCli(bin: string): boolean {
  return spawnSync("which", [bin]).status === 0;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommandOk("git", args, { cwd })).trim();
}

/** Shared singleton; retry CAS so parallel real-cli specs do not 409 each other. */
export async function enableSessionLogUploadAlways(request: APIRequestContext): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const settingsRes = await request.get(`${API}/api/v1/session-log-settings`);
    expect(settingsRes.ok(), `session-log-settings get failed: ${await settingsRes.text()}`).toBe(
      true,
    );
    const settings = (await settingsRes.json()) as { version?: number; uploadMode?: string };
    if (settings.uploadMode === "always") return;
    const upload = await request.put(`${API}/api/v1/session-log-settings`, {
      data: {
        version: settings.version ?? 0,
        uploadMode: "always",
        batchMaxKb: 1,
        batchMaxLines: 1,
        batchMaxWaitMs: 1000,
      },
    });
    if (upload.ok()) return;
    if (upload.status() !== 409) {
      expect(upload.ok(), `session-log-settings upload always failed: ${await upload.text()}`).toBe(
        true,
      );
      return;
    }
  }
  throw new Error("session-log-settings upload always: version conflict retries exhausted");
}

export type RealCliRepo = {
  root: string;
  repo: string;
  wt: string;
  hostId: string;
  repoId: string;
  wtId: string;
};

/** A fresh temp git repo plus the host/repo/worktree ids a real-cli spec routes through. */
export async function setupRealCliRepo(providerName: string): Promise<RealCliRepo> {
  const hostId = `pw-real-${providerName}-${Date.now()}`;
  const repoId = `pw-real-repo-${providerName}-${Date.now()}`;
  const wtId = `wt-${Date.now()}`;
  const root = mkdtempSync(join(tmpdir(), `pw-real-cli-${providerName}-`));
  const repo = join(root, "repo");
  const wt = join(root, wtId);

  mkdirSync(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "pw@pw"]);
  await git(repo, ["config", "user.name", "pw"]);
  writeFileSync(join(repo, "README"), `${providerName}\n`);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "init"]);
  await git(repo, ["branch", "-M", "main"]);

  return { root, repo, wt, hostId, repoId, wtId };
}

/** Create a catalog Provider plus its Command, and link the Command as the provider's default. */
export async function createCatalogProviderAndCommand(
  request: APIRequestContext,
  opts: {
    catalogName: string;
    argv: string[];
    appendPrompt: boolean;
    appendPromptSeparator?: boolean;
  },
): Promise<{ provider: { id: string }; command: { id: string } }> {
  const providerRes = await request.post(`${API}/api/v1/providers`, {
    data: { name: opts.catalogName },
  });
  expect(providerRes.ok(), `create provider failed: ${await providerRes.text()}`).toBeTruthy();
  const provider = (await providerRes.json()) as { id: string };

  const commandRes = await request.post(`${API}/api/v1/commands`, {
    data: {
      name: `${opts.catalogName}-print`,
      argv: opts.argv,
      appendPrompt: opts.appendPrompt,
      appendPromptSeparator: opts.appendPromptSeparator ?? true,
      providerId: provider.id,
    },
  });
  expect(commandRes.ok(), `create command failed: ${await commandRes.text()}`).toBeTruthy();
  const command = (await commandRes.json()) as { id: string };

  const patchRes = await request.patch(`${API}/api/v1/providers/${provider.id}`, {
    data: { defaultCommandId: command.id },
  });
  expect(patchRes.ok(), `set default command failed: ${await patchRes.text()}`).toBeTruthy();

  return { provider, command };
}

/** Create a providerless Command that runs ungated (no Provider Account needed). */
export async function createProviderlessCommand(
  request: APIRequestContext,
  opts: { name: string; argv: string[]; appendPrompt: boolean },
): Promise<{ id: string }> {
  const res = await request.post(`${API}/api/v1/commands`, {
    data: {
      name: opts.name,
      argv: opts.argv,
      appendPrompt: opts.appendPrompt,
      providerId: null,
    },
  });
  expect(res.ok(), `create providerless command failed: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { id: string };
}
