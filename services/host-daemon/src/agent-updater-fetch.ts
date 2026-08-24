import type { UpdateFetcher } from "./agent-updater.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

type UpdateFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

type UpdateResponse = Awaited<ReturnType<UpdateFetch>>;

export function createHttpsUpdateFetcher(
  manifestUrl: string,
  fetchFn: UpdateFetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): UpdateFetcher {
  requireHttps(manifestUrl, "update manifest URL");
  return {
    async fetchManifest() {
      return await timedFetch(fetchFn, manifestUrl, timeoutMs, async (response) => {
        if (!response.ok) throw new Error(`update manifest fetch failed: ${response.status}`);
        return await response.json();
      });
    },
    async fetchArtifact(url) {
      requireHttps(url, "update artifact URL");
      return await timedFetch(fetchFn, url, timeoutMs, async (response) => {
        if (!response.ok) throw new Error(`update artifact fetch failed: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      });
    },
  };
}

async function timedFetch<T>(
  fetchFn: UpdateFetch,
  url: string,
  timeoutMs: number,
  consume: (response: UpdateResponse) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { signal: controller.signal });
    return await consume(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("update fetch timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requireHttps(url: string, label: string): void {
  if (!url.startsWith("https://")) throw new Error(`${label} must be https`);
}
