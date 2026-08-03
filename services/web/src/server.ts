import { createServer } from "node:http";

import { createHttpApiClient } from "./create-session.ts";
import { send } from "./html.ts";
import { listenHttp, parsePortArg } from "./listen.ts";
import { handleAgentsDrainPost, handleAgentsGet } from "./pages/agents.ts";
import { handleRepositoriesGet, handleRepositoriesPost } from "./pages/repositories.ts";
import {
  handleScheduleTriggerPost,
  handleSchedulesGet,
  handleSchedulesPost,
} from "./pages/schedules.ts";
import {
  handleCreateSessionApi,
  handleNewSessionGet,
  handleSessionCancelPost,
  handleSessionCreatePost,
  handleSessionsListGet,
} from "./pages/sessions.ts";

export type WebServerOptions = {
  port?: number;
  apiBaseUrl?: string;
};

/**
 * Control-plane UI (:7421): org-wide sessions, repos, schedules, agent fleet.
 * Host inventory for a single agent lives on the agent pane (:7423).
 */
export async function startWebServer(options: WebServerOptions = {}): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const port = options.port ?? 7421;
  const apiBaseUrl = options.apiBaseUrl ?? process.env.HARNESS_API_HTTP ?? "http://127.0.0.1:7420";
  const client = createHttpApiClient(apiBaseUrl);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        send(res, 200, JSON.stringify({ ok: true, pane: "control" }), "application/json");
        return;
      }

      if (method === "GET" && (url.pathname === "/" || url.pathname === "/sessions/new")) {
        await handleNewSessionGet(res, client);
        return;
      }
      if (method === "GET" && url.pathname === "/sessions") {
        await handleSessionsListGet(res, apiBaseUrl);
        return;
      }
      const cancelSessionMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(url.pathname);
      if (method === "POST" && cancelSessionMatch) {
        await handleSessionCancelPost(res, apiBaseUrl, cancelSessionMatch[1]!);
        return;
      }
      if (method === "GET" && url.pathname === "/repositories") {
        await handleRepositoriesGet(res, apiBaseUrl);
        return;
      }
      if (method === "POST" && url.pathname === "/repositories") {
        await handleRepositoriesPost(req, res, apiBaseUrl);
        return;
      }
      if (method === "GET" && url.pathname === "/schedules") {
        await handleSchedulesGet(res, apiBaseUrl);
        return;
      }
      if (method === "POST" && url.pathname === "/schedules") {
        await handleSchedulesPost(req, res, apiBaseUrl);
        return;
      }
      const triggerMatch = /^\/schedules\/([^/]+)\/trigger$/.exec(url.pathname);
      if (method === "POST" && triggerMatch) {
        await handleScheduleTriggerPost(res, apiBaseUrl, triggerMatch[1]!);
        return;
      }
      if (method === "GET" && url.pathname === "/agents") {
        await handleAgentsGet(res, apiBaseUrl);
        return;
      }
      if (method === "POST" && url.pathname === "/agents/drain") {
        await handleAgentsDrainPost(req, res, apiBaseUrl);
        return;
      }
      if (method === "POST" && url.pathname === "/sessions") {
        await handleSessionCreatePost(req, res, client);
        return;
      }
      if (method === "POST" && url.pathname === "/api/create-session") {
        await handleCreateSessionApi(req, res, client);
        return;
      }

      send(res, 404, "not found", "text/plain");
    })().catch((err) => {
      send(res, 500, String(err), "text/plain");
    });
  });

  return listenHttp(server, port);
}

export function main(argv: string[] = process.argv): Promise<number> {
  const port = parsePortArg(argv, 7421);
  return startWebServer({ port }).then((s) => {
    console.log(`Auto Harness control-plane UI on http://127.0.0.1:${s.port}`);
    return new Promise(() => {
      /* run until killed */
    });
  });
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  void main();
}
