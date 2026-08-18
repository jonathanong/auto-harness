import type { HostIdentity } from "./config-types.ts";
import type { DaemonConfig } from "./config.ts";
import { fetchHostInventory, inventoryFingerprint } from "./bootstrap.ts";
import { DaemonLoop } from "./daemon-loop.ts";
import { createWsTransport } from "./ws-transport.ts";
import { resolveWsUrl } from "./ws-url.ts";

type StartDaemonOptions = {
  config: DaemonConfig;
  /** Identity for re-fetching host inventory from the control plane. */
  identity?: HostIdentity;
  /** Override WebSocket URL (default from config.apiUrl). */
  wsUrl?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Poll interval for host inventory updates (ms). Default 15s; 0 disables. */
  inventoryPollMs?: number;
  /** Maximum time to wait for the server's registration barrier (ms). */
  registrationTimeoutMs?: number;
  /** For tests: don't block forever. */
  runUntil?: Promise<void>;
  fetchFn?: typeof fetch;
};

type InventoryPollOptions = {
  config: DaemonConfig;
  identity: HostIdentity;
  applyInventory: (next: DaemonConfig) => Promise<void>;
  pollMs: number;
  log: (line: string) => void;
  error: (line: string) => void;
  // `| undefined` (not just optional) so callers can pass through their own already-
  // optional fetchFn without a conditional spread at every call site.
  fetchFn?: typeof fetch | undefined;
};

function noopInventoryPollStop(): Promise<void> {
  return Promise.resolve();
}

/**
 * Poll the control plane for inventory changes.
 *
 * The applied fingerprint is advanced only after the daemon accepts the new
 * inventory. A single-flight guard also prevents interval ticks from racing
 * while a fetch or inventory application is still in progress.
 */
export function startInventoryPoll(options: InventoryPollOptions): () => Promise<void> {
  let lastFp = inventoryFingerprint(options.config);
  let inFlight = false;
  let stopped = false;
  let activePoll: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    const poll = (async () => {
      try {
        const next = await fetchHostInventory(
          options.identity,
          options.fetchFn ? { fetchFn: options.fetchFn } : {},
        );
        const fp = inventoryFingerprint(next);
        if (fp === lastFp) {
          return;
        }
        await options.applyInventory(next);
        lastFp = fp;
        options.log(
          `host inventory updated from control plane (${next.repositories.length} repo(s))`,
        );
      } catch (err) {
        options.error(`inventory poll failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        inFlight = false;
      }
    })();
    activePoll = poll;
    // The poll body handles all failures and the single-flight guard prevents
    // replacement, so its successful settlement always owns this slot.
    void poll.then(() => {
      activePoll = undefined;
    });
  }, options.pollMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await activePoll;
  };
}

/**
 * Phase 3 agent daemon: connect WebSocket, register (even with empty inventory),
 * poll control plane for host inventory updates (repos attached via UI).
 */
export async function startDaemon(options: StartDaemonOptions): Promise<{
  stop: () => Promise<void>;
  loop: DaemonLoop;
}> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const baseUrl = options.wsUrl ?? options.config.apiUrl;
  if (!baseUrl) {
    throw new Error("apiUrl (or --ws) is required for start; e.g. ws://127.0.0.1:7420/ws");
  }
  // An explicit --ws override is allowed to target a raw API Gateway WebSocket endpoint
  // directly (a deploy-day escape hatch); HARNESS_API_URL is not, since the deployed
  // topology's one supported endpoint is the CloudFront URL. See ws-url.ts.
  const wsUrl = resolveWsUrl(baseUrl, { allowApiGatewayEndpoint: options.wsUrl !== undefined });

  const transport = createWsTransport({
    url: wsUrl,
    hostId: options.config.hostId,
    apiKey: options.config.apiKey,
    onError: (err) => {
      error(`ws error: ${err.message}`);
    },
    onClose: () => {
      log("ws closed");
    },
  });

  const loop = new DaemonLoop({
    config: options.config,
    transport,
    onLog: log,
  });
  await loop.start();
  try {
    await waitForRegistration(transport.registered, options.registrationTimeoutMs ?? 30_000, wsUrl);
  } catch (reason) {
    loop.stop();
    throw reason;
  }
  log(`connected and registered ${wsUrl}`);
  const repoCount = options.config.repositories.length;
  log(
    `agent ${options.config.hostId} registered` +
      (repoCount === 0
        ? " (no host inventory yet — add local repos in the host pane UI)"
        : ` (${repoCount} repo(s))`),
  );

  const pollMs = options.inventoryPollMs ?? 15_000;
  let stopInventoryPoll = noopInventoryPollStop;
  if (pollMs > 0 && options.identity) {
    stopInventoryPoll = startInventoryPoll({
      config: options.config,
      identity: options.identity,
      applyInventory: (next) => loop.applyInventory(next),
      pollMs,
      log,
      error,
      fetchFn: options.fetchFn,
    });
  }

  const keepalive = setInterval(() => {
    void loop.keepalive().catch((err: unknown) => {
      error(`keepalive failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 20_000);

  const stop = async (): Promise<void> => {
    // Keep this channel alive until the fenced drain commits. If it fails,
    // callers receive the error and can retry without exiting this daemon.
    await loop.beginDrain();
    await stopInventoryPoll();
    clearInterval(keepalive);
    await loop.waitForIdle();
    loop.stop();
  };

  if (options.runUntil) {
    await options.runUntil;
    await stop();
  }

  return { stop, loop };
}

async function waitForRegistration(
  registered: Promise<void>,
  timeoutMs: number,
  targetUrl: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      registered,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out waiting for WebSocket registration at ${targetUrl}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
