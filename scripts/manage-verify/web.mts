/**
 * Web manage-route verification (pages + form POSTs wired to real API).
 */
import { writeFileSync } from "node:fs";

import { ControlPlane } from "../../services/api/src/control-plane.ts";
import { startLocalServer } from "../../services/api/src/local-server.ts";
import { startWebServer } from "../../services/web/src/server.ts";

export async function manageWeb(scratch: string): Promise<void> {
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
  writeFileSync(`${scratch}/manage-web.log`, JSON.stringify(out, null, 2) + "\n");
  console.log("manage-web", ok ? "ok" : "FAIL");
  if (!ok) process.exitCode = 1;
}
