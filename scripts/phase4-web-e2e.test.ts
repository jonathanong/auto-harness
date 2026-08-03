import { describe, expect, it } from "vitest";

import { ControlPlane } from "../services/api/src/control-plane.js";
import { startLocalServer } from "../services/api/src/local-server.js";
import { startWebServer } from "../services/web/src/server.js";

describe("phase4 web create UI", () => {
  it("serves form and creates session with ref via real API", async () => {
    const plane = new ControlPlane({ publicBaseUrl: "http://ui" });
    plane.registerAgent({
      agentId: "a1",
      worktrees: [{ id: "wt-1", repositoryId: "demo", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt", "codex-fix"],
    });
    const apiPort = 19100 + Math.floor(Math.random() * 400);
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

    const form = await fetch(`http://127.0.0.1:${apiPort + 1}/`);
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain("echo-prompt");

    const created = await fetch(`http://127.0.0.1:${apiPort + 1}/api/create-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: "demo",
        prompt: "from web",
        commandProfile: "echo-prompt",
        timeout: 30,
        ref: "main",
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      ok: boolean;
      session: { ref?: string; commandProfile?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.session.ref).toBe("main");
    expect(body.session.commandProfile).toBe("echo-prompt");

    const bad = await fetch(`http://127.0.0.1:${apiPort + 1}/api/create-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: "demo",
        prompt: "x",
        commandProfile: "rm -rf /",
        timeout: 1,
      }),
    });
    expect(bad.status).toBe(400);

    await web.close();
    await api.close();
  });

  it("serves manage pages and wires repo/schedule/cancel/drain to API", async () => {
    const plane = new ControlPlane({
      publicBaseUrl: "http://ui",
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
      scheduleIdFactory: () => "sched-web",
      repositoryIdFactory: () => "repo-web",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane.registerAgent({
      agentId: "a1",
      worktrees: [{ id: "wt-1", repositoryId: "demo", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
    });
    const apiPort = 19200 + Math.floor(Math.random() * 400);
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

    for (const path of ["/", "/sessions", "/repositories", "/schedules", "/agents"]) {
      const page = await fetch(`${base}${path}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Repositories");
      expect(html).toContain("Schedules");
      expect(html).toContain("Agents");
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
    expect(createRepo.status).toBe(201);
    expect(await createRepo.text()).toContain("Repository created");
    expect(plane.getRepository("demo")?.name).toBe("Demo");

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
    expect(createSched.status).toBe(201);
    expect(plane.getSchedule("sched-web")?.name).toBe("nightly");

    const trigger = await fetch(`${base}/schedules/sched-web/trigger`, { method: "POST" });
    expect(trigger.status).toBe(201);
    const scheduled = plane.listSessions().find((s) => s.source === "schedule");
    expect(scheduled?.type).toBe("scheduled");

    plane.createSession({
      repositoryId: "demo",
      prompt: "web-cancel",
      commandProfile: "echo-prompt",
      timeout: 10,
    });
    const toCancel = plane.listSessions().find((s) => s.prompt === "web-cancel")!;
    const cancel = await fetch(`${base}/sessions/${toCancel.id}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    expect(plane.getSession(toCancel.id)?.status).toBe("cancelled");

    const drain = await fetch(`${base}/agents/drain`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ agentId: "a1" }).toString(),
    });
    expect(drain.status).toBe(200);
    expect(plane.isDraining("a1")).toBe(true);

    await web.close();
    await api.close();
  });
});
