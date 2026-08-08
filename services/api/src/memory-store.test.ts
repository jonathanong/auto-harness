import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { MemorySessionStore } from "./memory-store.ts";

describe("MemorySessionStore", () => {
  it("creates and lists sessions", () => {
    const store = new MemorySessionStore({
      publicBaseUrl: "http://ui",
      now: () => "2026-01-01T00:00:00.000Z",
      idFactory: () => "sess-fixed",
    });
    store.plane.createCommand({
      id: "cmd-codex",
      name: "codex-fix",
      argv: ["codex"],
      providerId: null,
    });
    const created = store.create({
      repositoryId: "repo-1",
      prompt: "fix",
      commandId: "cmd-codex",
      timeout: 60,
      ref: "main",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(created.session.url).toBe("http://ui/sessions/sess-fixed");
    expect(created.session.status).toBe("queued");
    expect(store.get("sess-fixed")?.prompt).toBe("fix");
    expect(store.list()).toHaveLength(1);
    expect(store.setStatus("sess-fixed", "running")?.status).toBe("running");
    expect(store.setStatus("missing", "failed")).toBeUndefined();
  });

  it("rejects invalid bodies", () => {
    const store = new MemorySessionStore();
    expect(store.create(null).ok).toBe(false);
    expect(store.create({ prompt: "x" }).ok).toBe(false);
  });

  it("uses default id and clock factories", () => {
    const store = new MemorySessionStore();
    store.plane.createCommand({ id: "cmd-c", name: "c", argv: ["echo"], providerId: null });
    const created = store.create({
      repositoryId: "r",
      prompt: "p",
      commandId: "cmd-c",
      timeout: 1,
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.session.id.startsWith("sess-")).toBe(true);
      expect(created.session.createdAt.length).toBeGreaterThan(0);
    }
  });

  it("accepts an injected plane", () => {
    const plane = new ControlPlane({ idFactory: () => "sess-inj", now: () => "t" });
    plane.createCommand({ id: "cmd-c", name: "c", argv: ["echo"], providerId: null });
    const store = new MemorySessionStore({ plane });
    const created = store.create({
      repositoryId: "r",
      prompt: "p",
      commandId: "cmd-c",
      timeout: 1,
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.session.id).toBe("sess-inj");
    }
    expect(store.get("missing")).toBeUndefined();
  });
});
