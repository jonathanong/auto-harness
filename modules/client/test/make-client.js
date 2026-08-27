import { AutoHarnessClient } from "../src/index.js";

/** A client whose fetch dispatches by pathname to a fixed handler map, recording every URL called. */
export function makeClient(handlers) {
  const calls = [];
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async (url, init) => {
      calls.push(url);
      const path = new URL(url).pathname;
      const handler = handlers[path];
      if (!handler) throw new Error(`unexpected request: ${url}`);
      return handler(init);
    },
  });
  return { client, calls };
}
