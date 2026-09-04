import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removePriorContextFile, writePriorContextFile } from "./prior-context-file.ts";

const identity = { apiUrl: "http://127.0.0.1:7420", apiKey: "secret-token" };

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "prior-context-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("writePriorContextFile", () => {
  it("fetches the running session's context and writes it with a self-ignoring .gitignore", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      fetchFn: async (url, init) => {
        request = { url, init: init as RequestInit };
        return new Response(
          JSON.stringify({ sourceSessionId: "sess-1", truncated: false, content: "transcript" }),
          { status: 200 },
        );
      },
    });
    expect(request?.url).toBe("http://127.0.0.1:7420/api/v1/sessions/sess-2/prior-context");
    expect(request!.init!.headers).toMatchObject({
      authorization: "Bearer secret-token",
    });
    expect(path).toBe(join(cwd, ".auto-harness", "prior-session.md"));
    expect(await readFile(path!, "utf8")).toBe("transcript");
    expect(await readFile(join(cwd, ".auto-harness", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("returns null without writing anything when there is no prior context (404)", async () => {
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      fetchFn: async () => new Response(null, { status: 404 }),
    });
    expect(path).toBeNull();
    await expect(
      readFile(join(cwd, ".auto-harness", "prior-session.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("swallows a non-2xx response and logs instead of throwing", async () => {
    const logs: string[] = [];
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      onLog: (message) => logs.push(message),
      fetchFn: async () => new Response("oops", { status: 500 }),
    });
    expect(path).toBeNull();
    expect(logs[0]).toContain("500");
  });

  it("swallows a response missing content", async () => {
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      fetchFn: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    expect(path).toBeNull();
  });

  it("swallows a declared content-length over the response cap", async () => {
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      fetchFn: async () =>
        new Response(JSON.stringify({ content: "x" }), {
          status: 200,
          headers: { "content-length": String(10 * 1024 * 1024) },
        }),
    });
    expect(path).toBeNull();
  });

  it("clamps an oversized body instead of writing an unbounded file", async () => {
    const huge = "x".repeat(6 * 1024 * 1024);
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      fetchFn: async () => new Response(JSON.stringify({ content: huge }), { status: 200 }),
    });
    const written = await readFile(path!, "utf8");
    expect(written.length).toBeLessThan(huge.length);
  });

  it("swallows a network failure", async () => {
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(path).toBeNull();
  });

  it("swallows a non-Error thrown value", async () => {
    const logs: string[] = [];
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      onLog: (message) => logs.push(message),
      fetchFn: () => {
        throw "not an Error instance";
      },
    });
    expect(path).toBeNull();
    expect(logs[0]).toContain("not an Error instance");
  });

  it("defaults to the global fetch when none is injected", async () => {
    // No daemon-managed control plane is listening in the test environment, so this
    // exercises the `fetchFn ?? fetch` fallback and still resolves to null, not a throw.
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity: { apiUrl: "http://127.0.0.1:1" },
    });
    expect(path).toBeNull();
  });

  it("swallows a containment violation from a symlink escape", async () => {
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      allowedRoots: ["/nonexistent-root-for-test"],
      fetchFn: async () => new Response(JSON.stringify({ content: "x" }), { status: 200 }),
    });
    expect(path).toBeNull();
  });
});

describe("removePriorContextFile", () => {
  it("is a no-op for a null path", async () => {
    await expect(removePriorContextFile(null)).resolves.toBeUndefined();
  });

  it("removes the file and tolerates it already being gone", async () => {
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      fetchFn: async () => new Response(JSON.stringify({ content: "x" }), { status: 200 }),
    });
    await removePriorContextFile(path);
    await expect(readFile(path!, "utf8")).rejects.toThrow();
    await expect(removePriorContextFile(path)).resolves.toBeUndefined();
  });
});
