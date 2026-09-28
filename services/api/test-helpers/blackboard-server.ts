import { createServer as createHttpServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { FeedbackEnvelope } from "vouchington-tooling/agent-blackboard";

/** Real HTTP boundary used with the published agent-blackboard client and shared writer. */
export async function blackboardServer(
  options: {
    port?: number;
    tls?: { key: string; cert: string };
  } = {},
) {
  const sessions = new Map<string, Record<string, unknown>>();
  const entries = new Map<string, Array<{ data: FeedbackEnvelope; createdAt: string }>>();
  const state = { refuse: false, hideReadback: false, loseAppendAck: false };
  const requests: string[] = [];
  const handler: RequestListener = async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (state.refuse) {
      response.writeHead(403);
      response.end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      : {};
    const path = new URL(request.url!, "http://127.0.0.1").pathname;
    if (path === "/health" && request.method === "GET") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === "/sessions" && request.method === "POST") {
      const id = body.id as string;
      if (sessions.has(id)) {
        response.writeHead(409);
        response.end("{}");
        return;
      }
      const session = { ...body, data: {}, archivedAt: null };
      sessions.set(id, session);
      response.end(JSON.stringify(session));
      return;
    }
    const match = /^\/sessions\/([^/]+)(\/entries)?$/.exec(path);
    const id = match?.[1] ?? "";
    if (match?.[2]) {
      if (request.method === "POST") {
        const entry = { data: body.data as FeedbackEnvelope, createdAt: new Date().toISOString() };
        entries.set(id, [...(entries.get(id) ?? []), entry]);
        if (state.loseAppendAck) {
          state.loseAppendAck = false;
          request.socket.destroy();
          return;
        }
        response.end(JSON.stringify(entry));
        return;
      }
      response.setHeader("content-type", "application/x-ndjson");
      response.end(
        state.hideReadback
          ? ""
          : (entries.get(id) ?? []).map((entry) => JSON.stringify(entry)).join("\n"),
      );
      return;
    }
    if (request.method === "PATCH" && sessions.has(id)) {
      sessions.get(id)!.data = body.data;
      response.end(JSON.stringify(sessions.get(id)));
      return;
    }
    if (sessions.has(id)) {
      response.end(JSON.stringify(sessions.get(id)));
      return;
    }
    response.writeHead(404);
    response.end("{}");
  };
  const server = options.tls ? createHttpsServer(options.tls, handler) : createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  return {
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${address.port}`,
    sessions,
    entries,
    state,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
