import { startLocalServer } from "./local-server.js";

export async function main(argv: string[] = process.argv): Promise<number> {
  const args = argv.slice(2);
  if (args[0] === "help" || args[0] === "--help") {
    console.log(`Usage:
  auto-harness-api serve [--port 7420]
`);
    return 0;
  }

  if (args[0] !== "serve" && args[0] !== undefined) {
    console.error(`Unknown command: ${args[0]}`);
    return 1;
  }

  let port = 7420;
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

  const server = await startLocalServer({ port, useDynamo: true });
  console.log(`Auto Harness local API listening on http://127.0.0.1:${server.port}`);
  console.log(`POST http://127.0.0.1:${server.port}/api/v1/sessions`);
  console.log(
    `DynamoDB: ${process.env.HARNESS_DDB_ENDPOINT ?? "http://127.0.0.1:8000"} (pnpm local:dynamodb)`,
  );

  await new Promise<void>(() => {
    /* run until killed */
  });
  return 0;
}

const isDirect =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirect || process.argv[1]?.endsWith("cli.ts")) {
  void main();
}
