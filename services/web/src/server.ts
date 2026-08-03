import { createServer } from "node:http";

import { createHttpApiClient } from "./create-session.ts";
import { send } from "./html.ts";
import { handleAgentsConfigPost, handleAgentsDrainPost, handleAgentsGet } from "./pages/agents.ts";
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
 * Minimal Phase 4 local web entry: create-session form + profile dropdown.
 * Profiles and create go to the real API (not free-text commands).
 */
export async function startWebServer(options: WebServerOptions = {}): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const port = options.port ?? 3000;
  const apiBaseUrl = options.apiBaseUrl ?? process.env.HARNESS_API_HTTP ?? "http://127.0.0.1:7420";
  const client = createHttpApiClient(apiBaseUrl);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        send(res, 200, JSON.stringify({ ok: true }), "application/json");
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

      if (method === "POST" && url.pathname === "/agents/config") {
        await handleAgentsConfigPost(req, res, apiBaseUrl);
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

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      resolve();
    });
    server.on("error", reject);
  });

  return {
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

export function main(argv: string[] = process.argv): Promise<number> {
  const args = argv.slice(2);
  let port = 3000;
  const portIdx = args.indexOf("--port");
  if (portIdx >= 0) {
    port = Number(args[portIdx + 1]);
  }
  return startWebServer({ port }).then((s) => {
    console.log(`Auto Harness web on http://127.0.0.1:${s.port}`);
    return new Promise(() => {
      /* run until killed */
    });
  });
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  void main();
}
