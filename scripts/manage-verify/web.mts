/**
 * Web manage-route verification — exercises control-plane API used by Next.js UI.
 * (Full browser UI: pnpm local:web against local:api.)
 */
import { writeFileSync } from "node:fs";

import { ControlPlane } from "../../services/api/src/control-plane.ts";
import { startLocalServer } from "../../services/api/src/local-server.ts";

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
  const base = `http://127.0.0.1:${apiPort}`;
  const pages: Record<string, number> = {};
  for (const path of [
    "/api/v1/sessions",
    "/api/v1/repositories",
    "/api/v1/schedules",
    "/api/v1/agents",
  ]) {
    const r = await fetch(`${base}${path}`);
    pages[path] = r.status;
  }
  const createRepo = await fetch(`${base}/api/v1/repositories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "demo",
      name: "Demo",
      url: "/tmp/demo",
      defaultBranch: "main",
    }),
  });
  const createSched = await fetch(`${base}/api/v1/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositoryId: "demo",
      name: "nightly",
      commandProfile: "echo-prompt",
      cron: "0 * * * *",
      timeout: 60,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
    }),
  });
  const trigger = await fetch(`${base}/api/v1/schedules/sched-web/trigger`, { method: "POST" });
  plane.createSession({
    repositoryId: "demo",
    prompt: "web-cancel",
    commandProfile: "echo-prompt",
    timeout: 10,
  });
  const toCancel = plane.listSessions().find((s) => s.prompt === "web-cancel")!;
  const cancel = await fetch(`${base}/api/v1/sessions/${toCancel.id}/cancel`, { method: "POST" });
  const drain = await fetch(`${base}/api/v1/agents/drain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "a1" }),
  });
  await api.close();
  writeFileSync(
    `${scratch}/web.json`,
    JSON.stringify(
      {
        pages,
        createRepo: createRepo.status,
        createSched: createSched.status,
        trigger: trigger.status,
        cancel: cancel.status,
        drain: drain.status,
      },
      null,
      2,
    ),
  );
}
