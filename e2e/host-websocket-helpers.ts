import { WS_BASE } from "./harness-endpoints.ts";

export async function registerObservedHost(
  hostId: string,
  daemonInstanceId: string,
  daemonStartedAt: string,
) {
  const socket = new WebSocket(WS_BASE);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string; message?: string };
      if (message.type === "host:registered") resolve();
      if (message.type === "error") reject(new Error(message.message));
    });
    socket.addEventListener("error", () => reject(new Error("host WebSocket failed")));
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          type: "host:register",
          hostId,
          daemonInstanceId,
          daemonStartedAt,
          worktrees: [],
          commandProfiles: [],
          runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
        }),
      ),
    );
  });
  return socket;
}

export async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
    socket.close();
  });
}
