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
});
