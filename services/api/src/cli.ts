import { installCrashLogging, onShutdownSignal } from "@auto-harness/shared";

import { publicBaseUrlFromEnv } from "./local-http.ts";
import { startLocalServer } from "./local-server.ts";

export async function main(argv: string[] = process.argv): Promise<number> {
  const args = argv.slice(2);
  if (args[0] === "help" || args[0] === "--help") {
    console.log(`Usage:
  auto-harness-api serve [--port 7420] [--host 127.0.0.1]
`);
    return 0;
  }

  if (args[0] !== "serve" && args[0] !== undefined) {
    console.error(`Unknown command: ${args[0]}`);
    return 1;
  }

  let port = 7420;
  let host = process.env.HARNESS_API_HOST ?? "127.0.0.1";
  const portIdx = args.indexOf("--port");
  if (portIdx >= 0) {
    const raw = args[portIdx + 1];
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      console.error("--port must be a positive number");
      return 1;
    }
    port = n;
  }
  const hostIdx = args.indexOf("--host");
  if (hostIdx >= 0) {
    const raw = args[hostIdx + 1];
    if (!raw || raw.startsWith("-")) {
      console.error("--host must be a hostname or IP address");
      return 1;
    }
    host = raw;
  }

  installCrashLogging();
  const publicBaseUrl = publicBaseUrlFromEnv();
  const server = await startLocalServer({
    port,
    host,
    useDynamo: true,
    ...(publicBaseUrl !== undefined ? { publicBaseUrl } : {}),
  });
  console.log(`Auto Harness local API listening on http://${host}:${server.port}`);
  console.log(`POST http://${host}:${server.port}/api/v1/sessions`);
  console.log(
    `DynamoDB: ${process.env.HARNESS_DDB_ENDPOINT ?? "http://127.0.0.1:7423"} (pnpm local:dynamodb)`,
  );

  // startLocalServer already returns a close() that stops the Slack and webhook workers,
  // the scheduler, both WebSocket hubs, and the HTTP server. Nothing was calling it, so
  // docker stop / systemctl stop severed in-flight requests and abandoned any sweep the
  // scheduler was mid-way through.
  await new Promise<void>((resolve) => {
    onShutdownSignal(async () => {
      console.log("shutting down");
      await server.close();
      resolve();
    });
  });
  return 0;
}

const isDirect =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirect || process.argv[1]?.endsWith("cli.ts")) {
  void main();
}
