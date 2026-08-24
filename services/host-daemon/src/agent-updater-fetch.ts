import type { UpdateFetcher } from "./agent-updater.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_UPDATE_MANIFEST_BYTES = 64 * 1024;
export const MAX_UPDATE_ARTIFACT_BYTES = 512 * 1024 * 1024;

type UpdateFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel?(): Promise<void>;
    };
  } | null;
  json?: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
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
        const bytes = await readResponseBytes(response, MAX_UPDATE_MANIFEST_BYTES, "manifest");
        if (bytes !== undefined) return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        if (!response.json) throw new Error("update manifest response has no body");
        return await response.json();
      });
    },
    async fetchArtifact(url) {
      requireHttps(url, "update artifact URL");
      return await timedFetch(fetchFn, url, timeoutMs, async (response) => {
        if (!response.ok) throw new Error(`update artifact fetch failed: ${response.status}`);
        const bytes = await readResponseBytes(response, MAX_UPDATE_ARTIFACT_BYTES, "artifact");
        if (bytes !== undefined) return bytes;
        if (!response.arrayBuffer) throw new Error("update artifact response has no body");
        const fallback = new Uint8Array(await response.arrayBuffer());
        if (fallback.byteLength > MAX_UPDATE_ARTIFACT_BYTES) {
          throw new Error(`update artifact response exceeds ${MAX_UPDATE_ARTIFACT_BYTES} bytes`);
        }
        return fallback;
      });
    },
  };
}

async function readResponseBytes(
  response: UpdateResponse,
  maxBytes: number,
  label: string,
): Promise<Uint8Array | undefined> {
  const contentLength = response.headers?.get("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`update ${label} response exceeds ${maxBytes} bytes`);
    }
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelled = false;
  const cancel = async (): Promise<void> => {
    if (cancelled || !reader.cancel) return;
    cancelled = true;
    await reader.cancel().catch(() => undefined);
  };
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value ?? new Uint8Array();
      total += chunk.byteLength;
      if (total > maxBytes) {
        await cancel();
        throw new Error(`update ${label} response exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await cancel();
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
