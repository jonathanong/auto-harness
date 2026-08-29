import { AutoHarnessClient } from "auto-harness-client";

export type ClientOptions = { baseUrl: string; apiKey: string; requestTimeoutMs: number };

export function client(options: ClientOptions): AutoHarnessClient {
  return new AutoHarnessClient(options);
}
