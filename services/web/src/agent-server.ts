import { createServer } from "node:http";

import { send } from "./html.ts";
import { listenHttp, parsePortArg } from "./listen.ts";
import {
  handleAgentPaneConfigGet,
  handleAgentPaneConfigPost,
  handleAgentPaneDrainPost,
  handleAgentPaneHome,
  type AgentPaneCtx,
} from "./pages/agent-pane.ts";

export type AgentWebServerOptions = {
  port?: number;
  apiBaseUrl?: string;
  agentId?: string;
};

/**
 * Agent pane UI (:7423): status, host inventory, drain for one HARNESS_AGENT_ID.
 * Control-plane UI stays on :7421.
 */
export async function startAgentWebServer(options: AgentWebServerOptions = {}): Promise<{
  port: number;
  close: () => Promise<void>;
  agentId: string;
}> {
  const agentId = options.agentId ?? process.env.HARNESS_AGENT_ID?.trim();
  if (!agentId) {
    throw new Error("HARNESS_AGENT_ID is required for the agent pane UI");
  }
  const port = options.port ?? 7423;
  const apiBaseUrl =
    options.apiBaseUrl ??
    process.env.HARNESS_API_HTTP ??
    process.env.HARNESS_API_URL ??
    "http://127.0.0.1:7420";
  // Normalize ws URL to http for REST
  let httpApi = apiBaseUrl;
  if (httpApi.startsWith("ws://")) {
    httpApi = `http://${httpApi.slice("ws://".length)}`;
  } else if (httpApi.startsWith("wss://")) {
    httpApi = `https://${httpApi.slice("wss://".length)}`;
  }
  httpApi = httpApi.replace(/\/ws\/?$/, "").replace(/\/$/, "");

  const ctx: AgentPaneCtx = { agentId, apiBaseUrl: httpApi };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        send(res, 200, JSON.stringify({ ok: true, pane: "agent", agentId }), "application/json");
        return;
      }
      if (method === "GET" && url.pathname === "/") {
        await handleAgentPaneHome(res, ctx);
        return;
      }
      if (method === "GET" && url.pathname === "/config") {
        await handleAgentPaneConfigGet(res, ctx);
        return;
      }
      if (method === "POST" && url.pathname === "/config") {
        await handleAgentPaneConfigPost(req, res, ctx);
        return;
      }
      if (method === "POST" && url.pathname === "/drain") {
        await handleAgentPaneDrainPost(res, ctx);
        return;
      }

      send(res, 404, "not found", "text/plain");
    })().catch((err) => {
      send(res, 500, String(err), "text/plain");
    });
  });

  const bound = await listenHttp(server, port);
  return { ...bound, agentId };
}

export function main(argv: string[] = process.argv): Promise<number> {
  const port = parsePortArg(argv, 7423);
  return startAgentWebServer({ port }).then((s) => {
    console.log(`Auto Harness agent pane UI on http://127.0.0.1:${s.port} (agentId=${s.agentId})`);
    return new Promise(() => {
      /* run until killed */
    });
  });
}

if (process.argv[1]?.endsWith("agent-server.ts") || process.argv[1]?.endsWith("agent-server.js")) {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
