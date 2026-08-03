import { describe, expect, it } from "vitest";

import { ControlPlane } from "../services/api/src/control-plane.ts";
import { startLocalServer } from "../services/api/src/local-server.ts";
import { startAgentWebServer } from "../services/web/src/agent-server.ts";

describe("agent pane UI", () => {
  it("serves status and saves host config for HARNESS_AGENT_ID", async () => {
    const plane = new ControlPlane({ publicBaseUrl: "http://ui" });
    plane.registerAgent({
      agentId: "local-1",
      worktrees: [{ id: "wt-1", repositoryId: "demo", path: "/w", labels: ["echo"] }],
      commandProfiles: ["echo-prompt"],
    });
    const apiPort = 19300 + Math.floor(Math.random() * 400);
    const api = await startLocalServer({
      port: apiPort,
      useDynamo: false,
      enableWs: false,
      plane,
      publicBaseUrl: "http://ui",
    });
    const agentWeb = await startAgentWebServer({
      port: apiPort + 1,
      apiBaseUrl: `http://127.0.0.1:${apiPort}`,
      agentId: "local-1",
    });
    const base = `http://127.0.0.1:${apiPort + 1}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ pane: "agent", agentId: "local-1" });

    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain("Agent pane");
    expect(homeHtml).toContain("local-1");
    expect(homeHtml).toContain("wt-1");

    const configPage = await fetch(`${base}/config`);
    expect(configPage.status).toBe(200);
    expect(await configPage.text()).toContain("Host inventory");

    const saved = await fetch(`${base}/config`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        configJson: JSON.stringify({
          repositories: [
            {
              id: "demo",
              path: "/repo",
              defaultBranch: "main",
              worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: ["echo"] }],
            },
          ],
          commandProfiles: { "echo-prompt": { argv: ["echo"], appendPrompt: true } },
        }),
      }).toString(),
    });
    expect(saved.status).toBe(200);
    expect(plane.getAgentHostConfig("local-1")?.repositories[0]?.path).toBe("/repo");

    const drain = await fetch(`${base}/drain`, { method: "POST" });
    expect(drain.status).toBe(200);
    expect(plane.isDraining("local-1")).toBe(true);

    await agentWeb.close();
    await api.close();
  });

  it("requires agentId", async () => {
    await expect(startAgentWebServer({ agentId: "" })).rejects.toThrow(/HARNESS_AGENT_ID/);
  });
});
