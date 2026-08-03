/**
 * Session cancel + agent drain verification against a real local API server.
 */
import { writeFileSync } from "node:fs";

import { ControlPlane } from "../../services/api/src/control-plane.ts";
import { startLocalServer } from "../../services/api/src/local-server.ts";

export async function manageSessionsAgents(scratch: string): Promise<void> {
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
  writeFileSync(`${scratch}/manage-sessions-agents.log`, JSON.stringify(out, null, 2) + "\n");
  console.log("manage-sessions-agents", ok ? "ok" : "FAIL");
  if (!ok) process.exitCode = 1;
}
