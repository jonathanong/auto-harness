/**
 * Repository CRUD verification against a real local API server.
 */
import { writeFileSync } from "node:fs";

import { ControlPlane } from "../../services/api/src/control-plane.ts";
import { startLocalServer } from "../../services/api/src/local-server.ts";

export async function manageRepos(scratch: string): Promise<void> {
  const plane = new ControlPlane({
    repositoryIdFactory: () => "repo-manage",
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const port = 18500 + Math.floor(Math.random() * 200);
  const api = await startLocalServer({ port, useDynamo: false, enableWs: false, plane });
  const base = `http://127.0.0.1:${port}`;
  const steps: unknown[] = [];
  const create = await fetch(`${base}/api/v1/repositories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "demo",
      name: "Demo",
      url: "/tmp/demo",
      defaultBranch: "main",
      setupScript: "s.sh",
    }),
  });
  steps.push({ create: create.status, body: await create.json() });
  const get = await fetch(`${base}/api/v1/repositories/demo`);
  steps.push({ get: get.status, body: await get.json() });
  const list = await fetch(`${base}/api/v1/repositories`);
  steps.push({ list: list.status, body: await list.json() });
  const put = await fetch(`${base}/api/v1/repositories/demo`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Demo2", url: "/tmp/d2", defaultBranch: "dev" }),
  });
  const putBody = (await put.json()) as { name?: string };
  steps.push({ put: put.status, body: putBody });
  const del = await fetch(`${base}/api/v1/repositories/demo`, { method: "DELETE" });
  steps.push({ del: del.status });
  const get2 = await fetch(`${base}/api/v1/repositories/demo`);
  steps.push({ getAfterDelete: get2.status });
  await api.close();
  const ok =
    create.status === 201 &&
    get.status === 200 &&
    list.status === 200 &&
    put.status === 200 &&
    putBody.name === "Demo2" &&
    del.status === 204 &&
    get2.status === 404;
  const out = { ok, steps };
  writeFileSync(`${scratch}/manage-repos.log`, JSON.stringify(out, null, 2) + "\n");
  console.log("manage-repos", ok ? "ok" : "FAIL");
  if (!ok) process.exitCode = 1;
}
