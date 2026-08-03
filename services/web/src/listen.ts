import type { Server } from "node:http";

/** Shared listen + close helpers for control and agent web servers. */
export async function listenHttp(
  server: Server,
  port: number,
): Promise<{ port: number; close: () => Promise<void> }> {
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

export function parsePortArg(argv: string[], defaultPort: number): number {
  const args = argv.slice(2);
  const portIdx = args.indexOf("--port");
  if (portIdx >= 0) {
    return Number(args[portIdx + 1]);
  }
  return defaultPort;
}
