import type { AgentConfig } from "./config.js";
import { AgentLoop } from "./agent-loop.js";
import { createWsTransport } from "./ws-transport.js";

type StartDaemonOptions = {
  config: AgentConfig;
  /** Override WebSocket URL (default from config.apiUrl). */
  wsUrl?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** For tests: don't block forever. */
  runUntil?: Promise<void>;
};

/**
 * Phase 3 agent daemon: connect WebSocket, register, accept assigns.
 * Keepalive is agent-initiated (not server timer).
 */
export async function startAgentDaemon(options: StartDaemonOptions): Promise<{
  stop: () => Promise<void>;
  loop: AgentLoop;
}> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const baseUrl = options.wsUrl ?? options.config.apiUrl;
  if (!baseUrl) {
    throw new Error("apiUrl (or --ws) is required for start; e.g. ws://127.0.0.1:7420/ws");
  }
  // Accept http(s) and rewrite to ws(s)
  let wsUrl = baseUrl;
  if (wsUrl.startsWith("http://")) {
    wsUrl = `ws://${wsUrl.slice("http://".length)}`;
  } else if (wsUrl.startsWith("https://")) {
    wsUrl = `wss://${wsUrl.slice("https://".length)}`;
  }
  if (!wsUrl.includes("/ws")) {
    wsUrl = wsUrl.replace(/\/$/, "") + "/ws";
  }

  const transport = createWsTransport({
    url: wsUrl,
    agentId: options.config.agentId,
    onError: (err) => {
      error(`ws error: ${err.message}`);
    },
    onClose: () => {
      log("ws closed");
    },
  });

  await transport.ready;
  log(`connected ${wsUrl}`);

  const loop = new AgentLoop({
    config: options.config,
    transport,
    onLog: log,
  });
  await loop.start();
  log(`agent ${options.config.agentId} registered`);

  const keepalive = setInterval(() => {
    void loop.keepalive().catch((err: unknown) => {
      error(`keepalive failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 20_000);

  const stop = async (): Promise<void> => {
    clearInterval(keepalive);
    loop.beginDrain();
    await loop.waitForIdle();
    loop.stop();
  };

  if (options.runUntil) {
    await options.runUntil;
    await stop();
  }

  return { stop, loop };
}
