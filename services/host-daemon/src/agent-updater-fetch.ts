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

export function createHttpsUpdateFetcher(
  manifestUrl: string,
  fetchFn: UpdateFetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): UpdateFetcher {
  requireHttps(manifestUrl, "update manifest URL");
  return {
    async fetchManifest() {
      const response = await timedFetch(fetchFn, manifestUrl, timeoutMs);
      if (!response.ok) throw new Error(`update manifest fetch failed: ${response.status}`);
      return await response.json();
    },
    async fetchArtifact(url) {
      requireHttps(url, "update artifact URL");
      const response = await timedFetch(fetchFn, url, timeoutMs);
      if (!response.ok) throw new Error(`update artifact fetch failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

async function timedFetch(
  fetchFn: UpdateFetch,
  url: string,
  timeoutMs: number,
): Promise<Awaited<ReturnType<UpdateFetch>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { signal: controller.signal });
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
