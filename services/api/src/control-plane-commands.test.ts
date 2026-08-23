import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("ControlPlane command CRUD", () => {
  it("validates, creates, lists, updates, and deletes commands", () => {
    let n = 0;
    const plane = new ControlPlane({
      commandIdFactory: () => `cmd-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
    });

    expect(plane.createCommand({ name: "", argv: ["echo"] }).ok).toBe(false);
    expect(plane.createCommand({ name: "echo hello world", argv: [] }).ok).toBe(false);
    expect(plane.createCommand({ name: "echo hello world", argv: [""] }).ok).toBe(false);

    const standalone = plane.createCommand({ name: "echo hello world", argv: ["echo", "hello"] });
    expect(standalone.ok).toBe(true);
    if (!standalone.ok) {
      throw new Error("unreachable");
    }
    expect(standalone.command).toMatchObject({
      id: "cmd-1",
      name: "echo hello world",
      argv: ["echo", "hello"],
      appendPrompt: true,
      appendPromptSeparator: false,
      providerId: null,
    });

    expect(plane.createCommand({ id: "cmd-1", name: "dup", argv: ["x"] }).ok).toBe(false);

    plane.createProvider({ id: "prov-1", name: "claude" });
    const owned = plane.createCommand({
      name: "claude-print",
      argv: ["claude", "-p"],
      providerId: "prov-1",
    });
    expect(owned.ok).toBe(true);
    if (owned.ok) {
      expect(owned.command).toMatchObject({
        appendPrompt: true,
        appendPromptSeparator: true,
        providerId: "prov-1",
      });
    }

    expect(plane.getCommand("cmd-1")?.name).toBe("echo hello world");
    expect(plane.getCommand("missing")).toBeNull();
    expect(plane.listCommands().map((c) => c.name)).toEqual(["claude-print", "echo hello world"]);

    expect(plane.updateCommand("missing", { name: "x" }).ok).toBe(false);
    expect(plane.updateCommand("cmd-1", { argv: [] }).ok).toBe(false);
    const updated = plane.updateCommand("cmd-1", {
      argv: ["echo", "hi"],
      appendPromptSeparator: true,
      providerId: "prov-1",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.command).toMatchObject({
        argv: ["echo", "hi"],
        appendPromptSeparator: true,
        providerId: "prov-1",
      });
    }

    expect(plane.deleteCommand("missing").ok).toBe(false);
    expect(plane.deleteCommand("cmd-1").ok).toBe(true);
    expect(plane.getCommand("cmd-1")).toBeNull();
  });

  it("blocks deleting a command that is a provider's default", () => {
    const plane = new ControlPlane({ now: () => "t" });
    plane.createCommand({ id: "cmd-1", name: "echo", argv: ["echo"] });
    plane.createProvider({ id: "prov-1", name: "claude", defaultCommandId: "cmd-1" });

    expect(plane.deleteCommand("cmd-1").ok).toBe(false);
    plane.updateProvider("prov-1", { defaultCommandId: null });
    expect(plane.deleteCommand("cmd-1").ok).toBe(true);
  });

  it("validates and persists native resume configuration", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    expect(
      plane.createCommand({
        name: "invalid",
        argv: ["tool"],
        resumeArgvTemplate: ["tool", "{unknown}"],
      }).ok,
    ).toBe(false);
    const created = plane.createCommand({
      name: "codex",
      argv: ["codex", "exec"],
      resumeArgvTemplate: ["codex", "resume", "{cliResumeRef}", "{prompt}"],
      resumeRefCapture: { stream: "stdout", linePrefix: "session id: " },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(created.command.resumeArgvTemplate).toEqual([
      "codex",
      "resume",
      "{cliResumeRef}",
      "{prompt}",
    ]);
    expect(created.command.resumeRefCapture).toEqual({
      stream: "stdout",
      linePrefix: "session id: ",
    });
    expect(
      plane.updateCommand(created.command.id, { resumeArgvTemplate: ["x", "{unknown}"] }).ok,
    ).toBe(false);
    expect(plane.updateCommand(created.command.id, { resumeArgvTemplate: null }).ok).toBe(true);
    expect(plane.getCommand(created.command.id)?.resumeArgvTemplate).toBeUndefined();
    expect(plane.updateCommand(created.command.id, { resumeRefCapture: null }).ok).toBe(true);
    expect(plane.getCommand(created.command.id)?.resumeRefCapture).toBeUndefined();
  });
});
