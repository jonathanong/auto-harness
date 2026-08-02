/**
 * Real HTTP POST /sessions with ref + commandProfile → 201 + url.
 */
import { createLocalApp } from "../services/api/src/local-server.ts";
import { ControlPlane } from "../services/api/src/control-plane.ts";
import { createServer } from "node:http";

async function main(): Promise<void> {
  const plane = new ControlPlane({ publicBaseUrl: "http://ui.example" });
  plane.registerAgent({
    agentId: "a1",
    worktrees: [{ id: "wt-1", repositoryId: "demo", path: "/w", labels: ["echo"] }],
    commandProfiles: ["echo-prompt"],
  });
  const { handler } = createLocalApp({ plane });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("no port");
  }
  const base = `http://127.0.0.1:${addr.port}`;
  const res = await fetch(`${base}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositoryId: "demo",
      prompt: "phase2 post",
      commandProfile: "echo-prompt",
      timeout: 60,
      ref: "main",
      concurrencyKey: "ck-1",
      onConflict: "queue",
      metadata: { phase: 2 },
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  console.log(JSON.stringify({ status: res.status, body }));
  if (res.status !== 201 || body.url == null || body.ref !== "main") {
    process.exitCode = 1;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
