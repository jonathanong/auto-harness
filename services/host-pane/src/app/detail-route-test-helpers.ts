import * as React from "react";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@auto-harness/ui";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";

const router = {
  back() {},
  forward() {},
  prefetch: async () => undefined,
  push() {},
  refresh() {},
  replace() {},
} satisfies AppRouterInstance;

let server: Server | undefined;
let replies: Record<string, unknown | number> = {};

export const inventory = {
  repositories: [
    {
      id: "repo/one",
      path: "/repos/one",
      worktrees: [{ id: "wt/one", name: "first", path: "/repos/one/first", labels: ["fast"] }],
    },
    {
      id: "repo-two",
      path: "/repos/two",
      worktrees: [{ id: "wt-two", name: "second", path: "/repos/two/second", labels: [] }],
    },
  ],
};

export async function startRouteTestServer() {
  replies = {};
  server = createServer((request, response) => {
    const reply = replies[request.url ?? ""];
    if (typeof reply === "number") {
      response.writeHead(reply, { "content-type": "text/plain" });
      response.end("error");
      return;
    }
    response.writeHead(reply === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply ?? {}));
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  process.env.HARNESS_API_HTTP = `http://127.0.0.1:${port}`;
}

export async function resetRouteTestState() {
  delete process.env.HARNESS_HOST_ID;
  delete process.env.HARNESS_API_HTTP;
  if (!server) return;
  const active = server;
  server = undefined;
  await new Promise<void>((resolve, reject) =>
    active.close((error) => (error ? reject(error) : resolve())),
  );
}

export function setApiReplies(next: Record<string, unknown | number>) {
  replies = next;
}

export async function renderRoute(node: Promise<React.ReactNode>) {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(AppRouterContext.Provider, { value: router }, await node),
    ),
  );
}
