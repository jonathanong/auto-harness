import { describe, expect, it } from "vitest";

import {
  createHttpApiClient,
  createSessionFromUi,
  validateCreateSessionForm,
} from "./create-session.js";

describe("validateCreateSessionForm", () => {
  it("accepts ref and agent-reported profile only", () => {
    const ok = validateCreateSessionForm({
      repositoryId: "demo",
      prompt: "hi",
      commandProfile: "echo-prompt",
      timeout: 30,
      ref: "main",
      concurrencyKey: "ck",
      onConflict: "queue",
      availableProfiles: ["echo-prompt", "codex-fix"],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.body.ref).toBe("main");
      expect(ok.body.source).toBe("ui");
      expect(ok.body.concurrencyKey).toBe("ck");
      expect(ok.body.onConflict).toBe("queue");
    }
  });

  it("rejects free-text profiles not reported by agents", () => {
    const bad = validateCreateSessionForm({
      repositoryId: "demo",
      prompt: "hi",
      commandProfile: "rm -rf /",
      timeout: 30,
      availableProfiles: ["echo-prompt"],
    });
    expect(bad.ok).toBe(false);
  });

  it("rejects empty available profiles list", () => {
    const bad = validateCreateSessionForm({
      repositoryId: "demo",
      prompt: "hi",
      commandProfile: "echo-prompt",
      timeout: 30,
      availableProfiles: [],
    });
    expect(bad.ok).toBe(false);
  });
});

describe("createSessionFromUi", () => {
  it("posts validated body and returns session", async () => {
    const client = {
      async listCommandProfiles() {
        return ["echo-prompt"];
      },
      async createSession(body: unknown) {
        return {
          status: 201,
          body: { id: "sess-1", ...(body as object), status: "queued", url: "/s/1" },
        };
      },
    };
    const result = await createSessionFromUi(client, {
      repositoryId: "demo",
      prompt: "from ui",
      commandProfile: "echo-prompt",
      timeout: 60,
      ref: "feature/ui",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session).toMatchObject({
        id: "sess-1",
        ref: "feature/ui",
        commandProfile: "echo-prompt",
      });
    }
  });

  it("surfaces API errors", async () => {
    const result = await createSessionFromUi(
      {
        async listCommandProfiles() {
          return ["echo-prompt"];
        },
        async createSession() {
          return {
            status: 400,
            body: { error: { message: "nope" } },
          };
        },
      },
      {
        repositoryId: "demo",
        prompt: "x",
        commandProfile: "echo-prompt",
        timeout: 1,
        availableProfiles: ["echo-prompt"],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("nope");
    }
  });

  it("createHttpApiClient talks to real local API shape", async () => {
    const client = createHttpApiClient("http://127.0.0.1:9");
    // Port 9 should refuse; ensures fetch path is real code
    await expect(client.listCommandProfiles()).rejects.toBeTruthy();
  });

  it("surfaces generic API errors and exercises http client success", async () => {
    const result = await createSessionFromUi(
      {
        async listCommandProfiles() {
          return ["echo-prompt"];
        },
        async createSession() {
          return { status: 500, body: { not: "error-shape" } };
        },
      },
      {
        repositoryId: "demo",
        prompt: "x",
        commandProfile: "echo-prompt",
        timeout: 1,
        availableProfiles: ["echo-prompt"],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("500");
    }

    // mock fetch for createHttpApiClient happy path
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("command-profiles")) {
        return new Response(JSON.stringify({ items: ["echo-prompt"] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: "sess-http",
          status: "queued",
          url: "/s",
          ...(JSON.parse(String(init?.body ?? "{}")) as object),
        }),
        { status: 201 },
      );
    }) as typeof fetch;
    try {
      const client = createHttpApiClient("http://example.test");
      expect(await client.listCommandProfiles()).toEqual(["echo-prompt"]);
      const created = await client.createSession({
        repositoryId: "demo",
        prompt: "p",
        commandProfile: "echo-prompt",
        timeout: 1,
      });
      expect(created.status).toBe(201);
      // empty items fallback
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
      expect(await client.listCommandProfiles()).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects invalid form fields from shared validation", () => {
    expect(
      validateCreateSessionForm({
        repositoryId: "",
        prompt: "p",
        commandProfile: "echo-prompt",
        timeout: 1,
        availableProfiles: ["echo-prompt"],
        concurrencyKey: "k",
        onConflict: "queue",
      }).ok,
    ).toBe(false);
  });

  it("createSessionFromUi returns form validation errors", async () => {
    const result = await createSessionFromUi(
      {
        async listCommandProfiles() {
          return ["echo-prompt"];
        },
        async createSession() {
          throw new Error("should not be called");
        },
      },
      {
        repositoryId: "demo",
        prompt: "x",
        commandProfile: "not-listed",
        timeout: 1,
      },
    );
    expect(result.ok).toBe(false);
  });
});
