/**
 * Repository CRUD verification against a real local API server.
 */
import { writeFileSync } from "node:fs";

import { ControlPlane } from "../../services/api/src/control-plane.ts";
import { startLocalServer } from "../../services/api/src/local-server.ts";

export const MANAGE_REPOSITORY_NAME = "demo";
const MANAGE_REPOSITORY_UPDATED_NAME = "demo2";

export async function manageRepos(scratch: string): Promise<void> {
  const plane = new ControlPlane({
    repositoryIdFactory: () => "repo-manage",
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const port = 18500 + Math.floor(Math.random() * 200);
  const api = await startLocalServer({ port, useDynamo: false, enableWs: false, plane });
  const base = `http://127.0.0.1:${port}`;
  const steps: unknown[] = [];
  try {
    const create = await fetch(`${base}/api/v1/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: MANAGE_REPOSITORY_NAME,
        url: "/tmp/demo",
        defaultBranch: "main",
        setupScript: "s.sh",
      }),
    });
    const createBody = (await create.json()) as { id?: string };
    steps.push({ create: create.status, body: createBody });
    const repositoryId = createBody.id ?? "missing-repository-id";
    const repositoryPath = `${base}/api/v1/repositories/${encodeURIComponent(repositoryId)}`;
    const get = await fetch(repositoryPath);
    steps.push({ get: get.status, body: await get.json() });
    const list = await fetch(`${base}/api/v1/repositories`);
    steps.push({ list: list.status, body: await list.json() });
    const put = await fetch(repositoryPath, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: MANAGE_REPOSITORY_UPDATED_NAME,
        url: "/tmp/d2",
        defaultBranch: "dev",
      }),
    });
    const putBody = (await put.json()) as { name?: string };
    steps.push({ put: put.status, body: putBody });
    const del = await fetch(repositoryPath, { method: "DELETE" });
    steps.push({ del: del.status });
    const get2 = await fetch(repositoryPath);
    steps.push({ getAfterDelete: get2.status });
    const ok =
      create.status === 201 &&
      get.status === 200 &&
      list.status === 200 &&
      put.status === 200 &&
      putBody.name === MANAGE_REPOSITORY_UPDATED_NAME &&
      del.status === 204 &&
      get2.status === 404;
    const out = { ok, steps };
    writeFileSync(`${scratch}/manage-repos.log`, JSON.stringify(out, null, 2) + "\n");
    console.log("manage-repos", ok ? "ok" : "FAIL");
    if (!ok) process.exitCode = 1;
  } finally {
    await api.close();
  }
}
