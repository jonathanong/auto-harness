/**
 * Control-plane UI helpers + URL state (Next.js app: pnpm local:web).
 */
import { describe, expect, it } from "vitest";

import {
  createSessionFromUi,
  validateCreateSessionForm,
} from "../services/web/src/create-session.ts";
import {
  hostListHref,
  parseSessionListState,
  sessionListHref,
} from "../services/web/src/lib/url-state.ts";

describe("phase4 web create UI helpers", () => {
  it("validates profiles (D4) and creates via API client shape", async () => {
    expect(
      validateCreateSessionForm({
        repositoryId: "demo",
        prompt: "x",
        commandProfile: "rm -rf /",
        timeout: 1,
        availableProfiles: ["echo-prompt"],
      }).ok,
    ).toBe(false);

    const client = {
      async listCommandProfiles() {
        return ["echo-prompt", "codex-fix"];
      },
      async createSession(body: unknown) {
        return {
          status: 201,
          body: { id: "sess-web", ...(body as object), status: "queued" },
        };
      },
    };
    const created = await createSessionFromUi(client, {
      repositoryId: "demo",
      prompt: "from web",
      commandProfile: "echo-prompt",
      timeout: 30,
      ref: "main",
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.session).toMatchObject({
        ref: "main",
        commandProfile: "echo-prompt",
      });
    }
  });

  it("keeps list filters in the URL", () => {
    expect(sessionListHref({ status: "running", q: "x" })).toContain("status=running");
    expect(parseSessionListState(new URLSearchParams("status=failed")).status).toBe("failed");
    expect(hostListHref({ online: "online" })).toBe("/hosts?online=online");
  });
});
