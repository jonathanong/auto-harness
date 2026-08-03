/**
 * Schedule CRUD + trigger verification against a real local API server.
 */
import { writeFileSync } from "node:fs";

import { ControlPlane } from "../../services/api/src/control-plane.ts";
import { startLocalServer } from "../../services/api/src/local-server.ts";

export async function manageSchedules(scratch: string): Promise<void> {
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
  writeFileSync(`${scratch}/manage-schedules.log`, JSON.stringify(out, null, 2) + "\n");
  console.log("manage-schedules", ok ? "ok" : "FAIL");
  if (!ok) process.exitCode = 1;
}
