import type { AgentIdentity } from "./config-types.ts";
import type { AgentConfig } from "./config.ts";
import { fetchAgentHostConfig, inventoryFingerprint } from "./bootstrap.ts";
import { AgentLoop } from "./agent-loop.ts";
import { createWsTransport } from "./ws-transport.ts";

type StartDaemonOptions = {
  config: AgentConfig;
  /** Identity for re-fetching host inventory from the control plane. */
  identity?: AgentIdentity;
  /** Override WebSocket URL (default from config.apiUrl). */
  wsUrl?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Poll interval for host inventory updates (ms). Default 15s; 0 disables. */
  inventoryPollMs?: number;
  /** For tests: don't block forever. */
  runUntil?: Promise<void>;
  fetchFn?: typeof fetch;
};

/**
 * Phase 3 agent daemon: connect WebSocket, register (even with empty inventory),
 * poll control plane for host inventory updates (repos attached via UI).
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
  const repoCount = options.config.repositories.length;
  log(
    `agent ${options.config.agentId} registered` +
      (repoCount === 0
        ? " (no host inventory yet — add local repos in the agent pane UI)"
        : ` (${repoCount} repo(s))`),
  );

  let lastFp = inventoryFingerprint(options.config);
  const pollMs = options.inventoryPollMs ?? 15_000;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  if (pollMs > 0 && options.identity) {
    const identity = options.identity;
    pollTimer = setInterval(() => {
      void (async () => {
        try {
          const next = await fetchAgentHostConfig(
            identity,
            options.fetchFn ? { fetchFn: options.fetchFn } : {},
          );
          const fp = inventoryFingerprint(next);
          if (fp === lastFp) {
            return;
          }
          lastFp = fp;
          await loop.applyInventory(next);
          log(
            `host inventory updated from control plane (${next.repositories.length} repo(s), ${Object.keys(next.commandProfiles).length} profile(s))`,
          );
        } catch (err) {
          error(`inventory poll failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }, pollMs);
  }

  const keepalive = setInterval(() => {
    void loop.keepalive().catch((err: unknown) => {
      error(`keepalive failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 20_000);

  const stop = async (): Promise<void> => {
    if (pollTimer) {
      clearInterval(pollTimer);
    }
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
