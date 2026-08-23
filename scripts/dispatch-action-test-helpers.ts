import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const actionPath = fileURLToPath(new URL("../actions/dispatch/dist/index.js", import.meta.url));
const servers: ReturnType<typeof createServer>[] = [];

type Response = { body: unknown; bodyDelayMs?: number; delayMs?: number; status?: number };
type Request = {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
};

export const drain = (status: string, overrides: Record<string, unknown> = {}) => ({
  operationId: "drain-1",
  repositoryId: "repo/one",
  status,
  statusUrl: "/api/v1/repositories/repo%2Fone/session-drains/drain-1",
  requestedAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:01.000Z",
  deadlineAt: "2026-08-22T00:15:00.000Z",
  queuedCount: 0,
  runningCount: 0,
  cancelledCount: 2,
  ...overrides,
});

export const closeDispatchActionServers = async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
};

export const serve = async (respond: (request: Request) => Response) => {
  const requests: Request[] = [];
  const server = createServer(async (request, response) => {
    requests.push({ headers: request.headers, method: request.method, url: request.url });
    const result = respond(requests.at(-1)!);
    if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    if (result.bodyDelayMs) {
      response.flushHeaders();
      await new Promise((resolve) => setTimeout(resolve, result.bodyDelayMs));
    }
    response.end(JSON.stringify(result.body));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind a TCP port");
  return { origin: `http://127.0.0.1:${address.port}`, requests };
};

export const runAction = async (inputs: Record<string, string>) => {
  const directory = await mkdtemp(join(tmpdir(), "auto-harness-dispatch-action-"));
  const output = join(directory, "github-output");
  const child = spawn(process.execPath, [actionPath], {
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      ...Object.fromEntries(
        Object.entries(inputs).map(([name, value]) => [
          `INPUT_${name.replaceAll("-", "_").toUpperCase()}`,
          value,
        ]),
      ),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = (await once(child, "close")) as [number | null];
  const outputText = await readFile(output, "utf8").catch(() => "");
  await rm(directory, { force: true, recursive: true });
  return {
    code,
    output: Object.fromEntries(
      outputText
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    ),
    stderr,
    stdout,
  };
};

export const drainInputs = (origin: string, operation: string) => ({
  "api-key": "test-key",
  operation,
  "repository-id": "repo/one",
  "server-url": origin,
});
