// @vitest-environment happy-dom
/* eslint-disable max-lines -- form scenarios share one focused API fixture. */

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import {
  createApiFake,
  field,
  json,
  mountForm,
  press,
  setValue,
} from "../../test-helpers/form-test-helpers.tsx";
import { GitHubIngressSettings } from "./github-ingress-settings.tsx";
import GitHubIngressSettingsPage from "../app/settings/github-ingress/page.tsx";

const existing = {
  id: "github-ingress",
  type: "github-ingress",
  enabled: true,
  secretConfigured: true,
  version: 2,
  generation: "generation-1",
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
  bindings: [
    {
      githubRepositoryId: 42,
      repositoryId: "repo",
      target: { providerId: "provider" },
      fallbacks: [{ commandId: "fallback" }],
      queueTtlSeconds: 3600,
      timeout: 120,
      priority: 5,
      requiredLabels: ["ready"],
      defaultRef: "refs/heads/main",
      allowedLogins: ["octocat"],
    },
  ],
};

async function settle() {
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
}

function labelled<T extends HTMLElement>(container: ParentNode, label: string): T {
  const element = container.querySelector(`[aria-label="${label}"]`);
  if (!element) throw new Error(`missing ${label}`);
  return element as T;
}

describe("GitHubIngressSettings", () => {
  it("loads, updates with a retained secret, edits bindings, and deletes", async () => {
    const fake = createApiFake(json(existing), json({ ...existing, version: 3 }), json({}, 204));
    const view = mountForm(<GitHubIngressSettings />);
    await settle();
    expect(labelled<HTMLInputElement>(view.container, "Auto Harness repository id").value).toBe(
      "repo",
    );
    press(field(view.container, "github-ingress-enabled"));
    const targetType = view.container.querySelector("select");
    if (!targetType) throw new Error("missing target type");
    setValue(targetType, "commandId");
    setValue(labelled(view.container, "Timeout seconds"), "240");
    setValue(labelled(view.container, "Queue TTL seconds"), "7200");
    setValue(labelled(view.container, "Priority"), "7");
    setValue(labelled(view.container, "Default ref"), "refs/heads/release");
    setValue(labelled(view.container, "Required labels"), "ready\nsafe");
    setValue(field(view.container, "github-ingress-fallback-type-0-0"), "providerId");
    setValue(field(view.container, "github-ingress-fallback-id-0-0"), "backup");
    press(field(view.container, "github-ingress-add-fallback-0"));
    setValue(field(view.container, "github-ingress-fallback-type-0-1"), "commandId");
    setValue(field(view.container, "github-ingress-fallback-id-0-1"), "fallback");
    press(field(view.container, "github-ingress-add-fallback-0"));
    const extraFallback = field(view.container, "github-ingress-fallback-id-0-2").parentElement;
    if (!extraFallback) throw new Error("missing extra fallback");
    press(extraFallback.querySelector("button")!);
    setValue(labelled(view.container, "Allowed GitHub logins"), "release-bot");
    press(field(view.container, "github-ingress-add-binding"));
    const remove = [...view.container.querySelectorAll("button")]
      .filter((button) => button.textContent === "Remove binding")
      .at(-1);
    if (!remove) throw new Error("missing remove binding");
    press(remove);
    press(field(view.container, "github-ingress-save"));
    await settle();
    const saved = JSON.parse(String(fake.requests[1]?.[1]?.body)) as Record<string, unknown>;
    expect(saved).not.toHaveProperty("secret");
    expect(saved).toMatchObject({
      version: 2,
      generation: "generation-1",
      bindings: [{ fallbacks: [{ providerId: "backup" }, { commandId: "fallback" }] }],
    });
    press(field(view.container, "github-ingress-delete"));
    expect(fake.requests).toHaveLength(2);
    press(
      [...field(view.container, "github-ingress-delete-confirm").querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      )!,
    );
    expect(document.querySelector('[data-pw="github-ingress-delete-confirm"]')).toBeNull();
    press(field(view.container, "github-ingress-delete"));
    press(field(view.container, "github-ingress-delete-confirm-submit"));
    await settle();
    expect(fake.requests[2]?.[1]?.method).toBe("DELETE");
    expect(fake.requests[2]?.[1]?.headers).toMatchObject({
      "if-match": "3",
      "if-match-generation": "generation-1",
    });
  });

  it("round-trips required labels containing commas", async () => {
    const commaExisting = {
      ...existing,
      bindings: existing.bindings.map((binding) => ({
        ...binding,
        requiredLabels: ["needs,review"],
      })),
    };
    const fake = createApiFake(json(commaExisting), json({ ...commaExisting, version: 3 }));
    const view = mountForm(<GitHubIngressSettings />);
    await settle();
    setValue(labelled(view.container, "Timeout seconds"), "240");
    press(field(view.container, "github-ingress-save"));
    await settle();
    const saved = JSON.parse(String(fake.requests[1]?.[1]?.body)) as {
      bindings: Array<{ requiredLabels: string[] }>;
    };
    expect(saved.bindings[0]?.requiredLabels).toEqual(["needs,review"]);
  });

  it.each([
    ["provider", { providerId: "team,provider" }],
    ["command", { commandId: "team,command" }],
  ] as const)(
    "round-trips %s fallback ids containing commas after an unrelated edit",
    async (_kind, fallback) => {
      const commaExisting = {
        ...existing,
        bindings: existing.bindings.map((binding) => ({
          ...binding,
          fallbacks: [fallback],
        })),
      };
      const fake = createApiFake(json(commaExisting), json({ ...commaExisting, version: 3 }));
      const view = mountForm(<GitHubIngressSettings />);
      await settle();
      expect(labelled<HTMLInputElement>(view.container, "Fallback 1 id").value).toBe(
        "providerId" in fallback ? fallback.providerId : fallback.commandId,
      );
      setValue(labelled(view.container, "Timeout seconds"), "240");
      press(field(view.container, "github-ingress-save"));
      await settle();
      const saved = JSON.parse(String(fake.requests[1]?.[1]?.body)) as {
        bindings: Array<{ fallbacks: unknown[] }>;
      };
      expect(saved.bindings[0]?.fallbacks).toEqual([fallback]);
    },
  );

  it("renders empty fallback rows without an identifier", async () => {
    createApiFake(
      json({
        ...existing,
        bindings: existing.bindings.map((binding) => ({
          ...binding,
          fallbacks: [{ providerId: null }, {}],
        })),
      }),
    );
    const view = mountForm(<GitHubIngressSettings />);
    await settle();
    expect(field<HTMLInputElement>(view.container, "github-ingress-fallback-id-0-0").value).toBe(
      "",
    );
    expect(field<HTMLSelectElement>(view.container, "github-ingress-fallback-type-0-0").value).toBe(
      "providerId",
    );
    expect(field<HTMLInputElement>(view.container, "github-ingress-fallback-id-0-1").value).toBe(
      "",
    );
    expect(field<HTMLSelectElement>(view.container, "github-ingress-fallback-type-0-1").value).toBe(
      "commandId",
    );
  });

  it("uses legacy generation headers when an older config omits generation", async () => {
    const legacy = { ...existing, generation: undefined };
    const fake = createApiFake(json(legacy), json({ version: 3 }), json({}, 204));
    const view = mountForm(<GitHubIngressSettings />);
    await settle();
    setValue(labelled(view.container, "Timeout seconds"), "240");
    press(field(view.container, "github-ingress-save"));
    await settle();
    const saved = JSON.parse(String(fake.requests[1]?.[1]?.body)) as Record<string, unknown>;
    expect(saved).toMatchObject({ version: 2, generation: "legacy" });
    press(field(view.container, "github-ingress-delete"));
    press(field(view.container, "github-ingress-delete-confirm-submit"));
    await settle();
    expect(fake.requests[2]?.[1]?.headers).toMatchObject({
      "if-match": "3",
      "if-match-generation": "legacy",
    });
  });

  it("loads command targets and provider fallbacks across multiple bindings", async () => {
    const alternate = {
      ...existing,
      bindings: [
        existing.bindings[0],
        {
          ...existing.bindings[0],
          githubRepositoryId: 43,
          repositoryId: "repo-two",
          target: { commandId: "command-two" },
          fallbacks: [{ providerId: "provider-two" }],
          requiredLabels: [],
          allowedLogins: [],
        },
      ],
    };
    const fake = createApiFake(json(alternate), json({ ...alternate, version: 3 }));
    const view = mountForm(<GitHubIngressSettings />);
    await settle();
    const targetTypes = [
      ...view.container.querySelectorAll<HTMLSelectElement>('[aria-label="Target type"]'),
    ];
    expect(targetTypes[1]?.value).toBe("commandId");
    expect(field<HTMLInputElement>(view.container, "github-ingress-fallback-id-1-0").value).toBe(
      "provider-two",
    );
    expect(field<HTMLSelectElement>(view.container, "github-ingress-fallback-type-1-0").value).toBe(
      "providerId",
    );
    const timeouts = [...view.container.querySelectorAll('[aria-label="Timeout seconds"]')];
    setValue(timeouts[1] as HTMLInputElement, "300");
    press(field(view.container, "github-ingress-save"));
    await settle();
    const saved = JSON.parse(String(fake.requests[1]?.[1]?.body)) as {
      bindings: Array<{ timeout: number; target: unknown; fallbacks: unknown[] }>;
    };
    expect(saved.bindings[1]).toMatchObject({
      timeout: 300,
      target: { commandId: "command-two" },
      fallbacks: [{ providerId: "provider-two" }],
    });
  });

  it("validates required values and rejects empty fallback ids", async () => {
    const fake = createApiFake(json({}, 404));
    const view = mountForm(<GitHubIngressSettings />);
    await settle();
    press(field(view.container, "github-ingress-save"));
    expect(document.body.textContent).toContain("Secret and every binding");
    setValue(field(view.container, "github-ingress-secret"), "s".repeat(32));
    setValue(labelled(view.container, "GitHub repository id"), "42");
    setValue(labelled(view.container, "Auto Harness repository id"), "repo");
    setValue(labelled(view.container, "Target id"), "provider");
    press(field(view.container, "github-ingress-add-fallback-0"));
    await settle();
    press(field(view.container, "github-ingress-save"));
    expect(document.body.textContent).toContain("provider or command id");
    setValue(field(view.container, "github-ingress-fallback-id-0-0"), "   ");
    await settle();
    press(field(view.container, "github-ingress-save"));
    expect(document.body.textContent).toContain("provider or command id");
    expect(fake.requests).toHaveLength(1);
  });

  it("creates a new configuration and reports save and delete failures", async () => {
    const fake = createApiFake(
      json({}, 404),
      json({ error: { code: "NO" } }, 400),
      json(existing),
      json({ error: { code: "NO" } }, 409),
    );
    const view = mountForm(<GitHubIngressSettings />);
    await settle();
    setValue(field(view.container, "github-ingress-secret"), "s".repeat(32));
    setValue(labelled(view.container, "GitHub repository id"), "42");
    setValue(labelled(view.container, "Auto Harness repository id"), "repo");
    setValue(labelled(view.container, "Target id"), "provider");
    await settle();
    press(field(view.container, "github-ingress-save"));
    await settle();
    expect(document.body.textContent).toContain("Unable to save");
    press(field(view.container, "github-ingress-save"));
    await settle();
    expect(fake.requests[2]?.[1]?.method).toBe("POST");
    press(field(view.container, "github-ingress-delete"));
    press(field(view.container, "github-ingress-delete-confirm-submit"));
    await settle();
    expect(document.body.textContent).toContain("Unable to delete");
  });

  it("reports an initial load failure", async () => {
    createApiFake(() => Promise.reject(new Error("offline")));
    mountForm(<GitHubIngressSettingsPage />);
    await settle();
    expect(document.body.textContent).toContain("Unable to load");
  });

  it("reports a rejected save request", async () => {
    createApiFake(json({}, 404), () => Promise.reject(new Error("offline")));
    const view = mountForm(<GitHubIngressSettings />);
    await settle();
    setValue(field(view.container, "github-ingress-secret"), "s".repeat(32));
    setValue(labelled(view.container, "GitHub repository id"), "42");
    setValue(labelled(view.container, "Auto Harness repository id"), "repo");
    setValue(labelled(view.container, "Target id"), "provider");
    press(field(view.container, "github-ingress-save"));
    await settle();
    expect(document.body.textContent).toContain("Unable to save");
  });

  it("keeps a secret edited while the save is in flight", async () => {
    let resolveSave!: (response: Response) => void;
    const fake = createApiFake(
      json(existing),
      () => new Promise<Response>((resolve) => (resolveSave = resolve)),
      json({ ...existing, version: 4, generation: "generation-2" }),
    );
    const view = mountForm(<GitHubIngressSettings />);
    await settle();
    setValue(field(view.container, "github-ingress-secret"), "old-secret");
    press(field(view.container, "github-ingress-save"));
    setValue(field(view.container, "github-ingress-secret"), "new-secret");
    resolveSave(json({ ...existing, version: 3, generation: "generation-2" }));
    await settle();
    expect(field<HTMLInputElement>(view.container, "github-ingress-secret").value).toBe(
      "new-secret",
    );
    expect(document.body.textContent).toContain("GitHub ingress configuration saved.");
    press(field(view.container, "github-ingress-save"));
    await settle();
    expect(JSON.parse(String(fake.requests[2]?.[1]?.body))).toMatchObject({
      version: 3,
      generation: "generation-2",
      secret: "new-secret",
    });
  });

  it("clears the submitted secret after the current save succeeds", async () => {
    createApiFake(json(existing), json({ ...existing, version: 3 }));
    const view = mountForm(<GitHubIngressSettings />);
    await settle();
    setValue(field(view.container, "github-ingress-secret"), "submitted-secret");
    press(field(view.container, "github-ingress-save"));
    await settle();
    expect(field<HTMLInputElement>(view.container, "github-ingress-secret").value).toBe("");
    expect(document.body.textContent).toContain("GitHub ingress configuration saved.");
  });

  it("does not clear a newer secret when the save fails", async () => {
    let resolveSave!: (response: Response) => void;
    createApiFake(
      json(existing),
      () => new Promise<Response>((resolve) => (resolveSave = resolve)),
    );
    const view = mountForm(<GitHubIngressSettings />);
    await settle();
    setValue(field(view.container, "github-ingress-secret"), "old-secret");
    press(field(view.container, "github-ingress-save"));
    setValue(field(view.container, "github-ingress-secret"), "new-secret");
    resolveSave(json({ error: { code: "NO" } }, 400));
    await settle();
    expect(field<HTMLInputElement>(view.container, "github-ingress-secret").value).toBe(
      "new-secret",
    );
    expect(document.body.textContent).toContain("Unable to save");
  });

  it.each([
    [403, "You do not have permission"],
    [500, "Unable to load"],
  ])("renders a load error for non-configuration response %s", async (status, message) => {
    createApiFake(json({ error: { code: "NO" } }, status));
    mountForm(<GitHubIngressSettingsPage />);
    await settle();
    expect(document.body.textContent).toContain(message);
    expect(document.body.querySelector('[data-pw="github-ingress-settings-card"]')).toBeNull();
  });
});
