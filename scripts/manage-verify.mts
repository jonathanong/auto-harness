/**
 * Operator management verification (SCRATCH proofs).
 * Drives real startLocalServer HTTP + startWebServer handlers.
 *
 * Usage: SCRATCH=/tmp/harness-manage-scratch pnpm local:manage-verify
 */
import { writeFileSync } from "node:fs";

import { ControlPlane } from "../services/api/src/control-plane.ts";
import { startLocalServer } from "../services/api/src/local-server.ts";
import { startWebServer } from "../services/web/src/server.ts";

const SCRATCH = process.env.SCRATCH ?? "/tmp/harness-manage-scratch";

async function manageRepos(): Promise<void> {
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
  writeFileSync(`${SCRATCH}/manage-repos.log`, JSON.stringify(out, null, 2) + "\n");
  console.log("manage-repos", ok ? "ok" : "FAIL");
  if (!ok) process.exitCode = 1;
}

async function manageSchedules(): Promise<void> {
  let n = 0;
  const plane = new ControlPlane({
    idFactory: () => `sess-${++n}`,
    scheduleIdFactory: () => "sched-1",
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const port = 18700 + Math.floor(Math.random() * 200);
  const api = await startLocalServer({ port, useDynamo: false, enableWs: false, plane });
  const base = `http://127.0.0.1:${port}`;
  const create = await fetch(`${base}/api/v1/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositoryId: "demo",
      name: "nightly",
      commandProfile: "echo-prompt",
      cron: "0 0 * * *",
      timeout: 30,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
      enabled: true,
    }),
  });
  const createBody = await create.json();
  const get = await fetch(`${base}/api/v1/schedules/sched-1`);
  const list = await fetch(`${base}/api/v1/schedules`);
  const patch = await fetch(`${base}/api/v1/schedules/sched-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "nightly2", timeout: 45 }),
  });
  const trigger = await fetch(`${base}/api/v1/schedules/sched-1/trigger`, { method: "POST" });
  const triggerBody = (await trigger.json()) as {
    type?: string;
    source?: string;
    prompt?: string;
  };
  const del = await fetch(`${base}/api/v1/schedules/sched-1`, { method: "DELETE" });
  await api.close();
  const ok =
    create.status === 201 &&
    get.status === 200 &&
    list.status === 200 &&
    patch.status === 200 &&
    trigger.status === 201 &&
    triggerBody.type === "scheduled" &&
    triggerBody.source === "schedule" &&
    del.status === 204;
  const out = {
    ok,
    create: create.status,
    createBody,
    get: get.status,
    list: list.status,
    patch: patch.status,
    trigger: trigger.status,
    triggerBody,
    del: del.status,
  };
  writeFileSync(`${SCRATCH}/manage-schedules.log`, JSON.stringify(out, null, 2) + "\n");
  console.log("manage-schedules", ok ? "ok" : "FAIL");
  if (!ok) process.exitCode = 1;
}

async function manageSessionsAgents(): Promise<void> {
  let n = 0;
  const plane = new ControlPlane({
    idFactory: () => `sess-${++n}`,
    now: () => "2026-01-01T00:00:00.000Z",
    shardCount: 1,
  });
  plane.seedWorktree({
    id: "wt-1",
    agentId: "a1",
    repositoryId: "r1",
    path: "/w",
    labels: [],
    status: "idle",
    online: true,
  });
  plane.registerAgent({
    agentId: "a1",
    worktrees: [{ id: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
    commandProfiles: ["echo-prompt"],
    replaceExisting: true,
  });
  const port = 18900 + Math.floor(Math.random() * 200);
  const api = await startLocalServer({ port, useDynamo: false, enableWs: false, plane });
  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(`${base}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositoryId: "r1",
      prompt: "cancel-me",
      commandProfile: "echo-prompt",
      timeout: 10,
    }),
  });
  const sess = (await created.json()) as { id: string };
  const listS = await fetch(`${base}/api/v1/sessions`);
  const cancel = await fetch(`${base}/api/v1/sessions/${sess.id}/cancel`, { method: "POST" });
  const cancelBody = (await cancel.json()) as { status?: string };
  const listA = await fetch(`${base}/api/v1/agents`);
  const agents = await listA.json();
  const drain = await fetch(`${base}/api/v1/agents/drain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "a1" }),
  });
  const drainBody = (await drain.json()) as { ok?: boolean };
  await api.close();
  const ok =
    created.status === 201 &&
    listS.status === 200 &&
    cancel.status === 200 &&
    cancelBody.status === "cancelled" &&
    listA.status === 200 &&
    drain.status === 200 &&
    drainBody.ok === true &&
    plane.isDraining("a1");
  const out = {
    ok,
    created: created.status,
    sess,
    listS: listS.status,
    cancel: cancel.status,
    cancelBody,
    listA: listA.status,
    agents,
    drain: drain.status,
    drainBody,
    isDraining: plane.isDraining("a1"),
  };
  writeFileSync(`${SCRATCH}/manage-sessions-agents.log`, JSON.stringify(out, null, 2) + "\n");
  console.log("manage-sessions-agents", ok ? "ok" : "FAIL");
  if (!ok) process.exitCode = 1;
}

async function manageWeb(): Promise<void> {
  let n = 0;
  const plane = new ControlPlane({
    publicBaseUrl: "http://ui",
    idFactory: () => `sess-${++n}`,
    scheduleIdFactory: () => "sched-web",
    repositoryIdFactory: () => "repo-web",
    now: () => "2026-01-01T00:00:00.000Z",
  });
  plane.registerAgent({
    agentId: "a1",
    worktrees: [{ id: "wt-1", repositoryId: "demo", path: "/w", labels: [] }],
    commandProfiles: ["echo-prompt"],
  });
  const apiPort = 19100 + Math.floor(Math.random() * 200);
  const api = await startLocalServer({
    port: apiPort,
    useDynamo: false,
    enableWs: false,
    plane,
    publicBaseUrl: "http://ui",
  });
  const web = await startWebServer({
    port: apiPort + 1,
    apiBaseUrl: `http://127.0.0.1:${apiPort}`,
  });
  const base = `http://127.0.0.1:${apiPort + 1}`;
  const pages: Record<string, number> = {};
  for (const path of ["/", "/sessions", "/repositories", "/schedules", "/agents"]) {
    const r = await fetch(`${base}${path}`);
    pages[path] = r.status;
  }
  const createRepo = await fetch(`${base}/repositories`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      id: "demo",
      name: "Demo",
      url: "/tmp/demo",
      defaultBranch: "main",
    }).toString(),
  });
  const createSched = await fetch(`${base}/schedules`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      repositoryId: "demo",
      name: "nightly",
      commandProfile: "echo-prompt",
      cron: "0 * * * *",
      timeout: "60",
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
    }).toString(),
  });
  const trigger = await fetch(`${base}/schedules/sched-web/trigger`, { method: "POST" });
  plane.createSession({
    repositoryId: "demo",
    prompt: "web-cancel",
    commandProfile: "echo-prompt",
    timeout: 10,
  });
  const toCancel = plane.listSessions().find((s) => s.prompt === "web-cancel")!;
  const cancel = await fetch(`${base}/sessions/${toCancel.id}/cancel`, { method: "POST" });
  const drain = await fetch(`${base}/agents/drain`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ agentId: "a1" }).toString(),
  });
  await web.close();
  await api.close();
  const ok =
    Object.values(pages).every((s) => s === 200) &&
    createRepo.status === 201 &&
    createSched.status === 201 &&
    trigger.status === 201 &&
    cancel.status === 200 &&
    drain.status === 200 &&
    plane.getRepository("demo")?.name === "Demo" &&
    plane.getSession(toCancel.id)?.status === "cancelled" &&
    plane.isDraining("a1");
  const out = {
    ok,
    pages,
    createRepo: createRepo.status,
    createSched: createSched.status,
    trigger: trigger.status,
    cancel: cancel.status,
    drain: drain.status,
    repo: plane.getRepository("demo"),
    cancelledStatus: plane.getSession(toCancel.id)?.status,
    isDraining: plane.isDraining("a1"),
  };
  writeFileSync(`${SCRATCH}/manage-web.log`, JSON.stringify(out, null, 2) + "\n");
  console.log("manage-web", ok ? "ok" : "FAIL");
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  await manageRepos();
  await manageSchedules();
  await manageSessionsAgents();
  await manageWeb();
}

await main();
