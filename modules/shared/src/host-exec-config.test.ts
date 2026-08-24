/* eslint-disable max-lines -- parse, apply, and inventory-write policy share one fixture. */
import { describe, expect, it } from "vitest";

import {
  applyHostExecConfig,
  inventoryHasExecConfig,
  isAbsolutePathString,
  listExecConfigEdits,
  parseAllowedRoots,
  parseHostExecConfig,
  parseTerminalHookScript,
  preserveHostExecConfig,
  reconcileInventoryWrite,
} from "./host-exec-config.ts";
import { emptyHostInventory, type HostInventory } from "./host-inventory.ts";

const inventory = (): HostInventory => ({
  setupScript: "source ~/.zshrc",
  allowedRoots: ["/opt/harness"],
  repositories: [
    {
      id: "repo-1",
      path: "/opt/harness/repo",
      defaultBranch: "main",
      setupScript: "pnpm install",
      terminalHookScript: "/opt/harness/hooks/done.sh",
      worktrees: [
        {
          id: "wt-1",
          name: "wt-1",
          path: "/opt/harness/repo/.worktrees/wt-1",
          labels: ["echo"],
          setupScript: "pnpm build",
        },
      ],
    },
  ],
  providerAccounts: [],
  capabilities: [],
});

describe("isAbsolutePathString", () => {
  it("accepts POSIX, Windows, and UNC paths", () => {
    expect(isAbsolutePathString("/opt/harness")).toBe(true);
    expect(isAbsolutePathString("C:\\harness")).toBe(true);
    expect(isAbsolutePathString("d:/harness")).toBe(true);
    expect(isAbsolutePathString("\\\\host\\share")).toBe(true);
    expect(isAbsolutePathString("relative/path")).toBe(false);
    expect(isAbsolutePathString("")).toBe(false);
  });
});

describe("parseAllowedRoots", () => {
  it("dedupes absolute roots and treats omit as undefined", () => {
    expect(parseAllowedRoots(undefined)).toBeUndefined();
    expect(parseAllowedRoots(["/a", "/a", "/b"])).toEqual(["/a", "/b"]);
    expect(parseAllowedRoots([])).toEqual([]);
  });

  it("rejects malformed roots", () => {
    expect(() => parseAllowedRoots("nope")).toThrow("string array");
    expect(() => parseAllowedRoots(["relative"])).toThrow("absolute");
    expect(() => parseAllowedRoots([""])).toThrow("non-empty");
    expect(() => parseAllowedRoots([`/${"a".repeat(4097)}`])).toThrow("at most 4096 characters");
    expect(() => parseAllowedRoots(Array.from({ length: 33 }, (_, i) => `/${String(i)}`))).toThrow(
      "at most 32",
    );
  });
});

describe("parseHostExecConfig", () => {
  it("parses omitted keys as a partial patch", () => {
    expect(parseHostExecConfig({})).toEqual({});
    expect(parseHostExecConfig({ allowedRoots: undefined })).toEqual({ allowedRoots: [] });
    expect(
      parseHostExecConfig({ repositories: [{ id: "repo", worktrees: [{ id: "wt" }] }] }),
    ).toEqual({
      repositories: [{ id: "repo", worktrees: [{ id: "wt" }] }],
    });
    expect(
      parseHostExecConfig({
        setupScript: "source ~/.zshrc",
        allowedRoots: ["/opt/harness"],
        repositories: [
          {
            id: "repo-1",
            setupScript: "pnpm i",
            terminalHookScript: "/opt/harness/hook.sh",
            worktrees: [{ id: "wt-1", setupScript: "pnpm build" }],
          },
        ],
      }),
    ).toEqual({
      setupScript: "source ~/.zshrc",
      allowedRoots: ["/opt/harness"],
      repositories: [
        {
          id: "repo-1",
          setupScript: "pnpm i",
          terminalHookScript: "/opt/harness/hook.sh",
          worktrees: [{ id: "wt-1", setupScript: "pnpm build" }],
        },
      ],
    });
  });

  it("rejects invalid patches", () => {
    expect(() => parseHostExecConfig(null)).toThrow("object");
    expect(() => parseHostExecConfig({ setupScript: 1 })).toThrow("setupScript");
    expect(() => parseHostExecConfig({ repositories: {} })).toThrow("array");
    expect(() => parseHostExecConfig({ repositories: [null] })).toThrow("object");
    expect(() => parseHostExecConfig({ repositories: [{}] })).toThrow("id");
    expect(() =>
      parseHostExecConfig({ repositories: [{ id: "repo", terminalHookScript: "hook.sh" }] }),
    ).toThrow("absolute path");
    expect(() =>
      parseHostExecConfig({ repositories: [{ id: "repo", worktrees: "nope" }] }),
    ).toThrow("worktrees must be an array");
    expect(() =>
      parseHostExecConfig({ repositories: [{ id: "repo", worktrees: [null] }] }),
    ).toThrow("invalid");
    expect(() => parseHostExecConfig({ repositories: [{ id: "repo", worktrees: [{}] }] })).toThrow(
      "id must be a non-empty string",
    );
    expect(() =>
      parseHostExecConfig({ repositories: [{ id: "repo", worktrees: [{ id: "" }] }] }),
    ).toThrow("id must be a non-empty string");
    expect(parseHostExecConfig({ repositories: [{ id: "repo", terminalHookScript: "" }] })).toEqual(
      {
        repositories: [{ id: "repo", terminalHookScript: "" }],
      },
    );
    expect(() =>
      parseHostExecConfig({
        repositories: [{ id: "repo", worktrees: [{ id: "wt", setupScript: 1 }] }],
      }),
    ).toThrow("setupScript must be a string");
    expect(() =>
      parseHostExecConfig({
        repositories: [{ id: "repo", terminalHookScript: `/${"a".repeat(4097)}` }],
      }),
    ).toThrow("too long");
    expect(parseTerminalHookScript(undefined, "repo")).toBeUndefined();
    expect(parseTerminalHookScript("", "repo")).toBe("");
    expect(parseTerminalHookScript("/opt/hook.sh", "repo")).toBe("/opt/hook.sh");
  });
});

describe("applyHostExecConfig", () => {
  it("merges host, repository, and worktree exec fields and can clear them", () => {
    const updated = applyHostExecConfig(inventory(), {
      setupScript: "echo host",
      allowedRoots: ["/opt/harness", "/usr/local"],
      repositories: [
        {
          id: "repo-1",
          setupScript: "",
          terminalHookScript: "/opt/harness/hooks/other.sh",
          worktrees: [{ id: "wt-1", setupScript: "" }],
        },
      ],
    });
    expect(updated.setupScript).toBe("echo host");
    expect(updated.allowedRoots).toEqual(["/opt/harness", "/usr/local"]);
    expect(updated.repositories[0]?.setupScript).toBeUndefined();
    expect(updated.repositories[0]?.terminalHookScript).toBe("/opt/harness/hooks/other.sh");
    expect(updated.repositories[0]?.worktrees[0]?.setupScript).toBeUndefined();
    expect(updated.repositories[0]?.path).toBe("/opt/harness/repo");
    expect(applyHostExecConfig(inventory(), { allowedRoots: [] })).not.toHaveProperty(
      "allowedRoots",
    );
  });

  it("rejects unknown repository or worktree ids", () => {
    expect(() => applyHostExecConfig(inventory(), { repositories: [{ id: "missing" }] })).toThrow(
      "Unknown repository",
    );
    expect(() =>
      applyHostExecConfig(inventory(), {
        repositories: [{ id: "repo-1", worktrees: [{ id: "missing" }] }],
      }),
    ).toThrow("Unknown worktree");
  });
});

describe("listExecConfigEdits / preserve / reconcile", () => {
  it("reports full-state removals and execution-base changes for setup scripts", () => {
    expect(listExecConfigEdits(inventory(), emptyHostInventory())).toEqual([
      "setupScript",
      "allowedRoots",
      "repositories.repo-1.setupScript",
      "repositories.repo-1.terminalHookScript",
      "repositories.repo-1.worktrees.wt-1.setupScript",
    ]);
    const ordinaryInventoryWrite = inventory();
    delete ordinaryInventoryWrite.setupScript;
    delete ordinaryInventoryWrite.allowedRoots;
    delete ordinaryInventoryWrite.repositories[0]!.setupScript;
    delete ordinaryInventoryWrite.repositories[0]!.terminalHookScript;
    delete ordinaryInventoryWrite.repositories[0]!.worktrees[0]!.setupScript;
    expect(
      listExecConfigEdits(inventory(), preserveHostExecConfig(ordinaryInventoryWrite, inventory())),
    ).toEqual([]);
    const moved = {
      ...emptyHostInventory(),
      setupScript: "source ~/.zshrc",
      allowedRoots: ["/opt/harness"],
      repositories: [
        {
          id: "repo-1",
          path: "/elsewhere",
          defaultBranch: "main",
          setupScript: "pnpm install",
          terminalHookScript: "/opt/harness/hooks/done.sh",
          worktrees: [
            {
              id: "wt-1",
              name: "wt-1",
              path: "/elsewhere",
              labels: [],
              setupScript: "pnpm build",
            },
          ],
        },
      ],
    };
    expect(listExecConfigEdits(inventory(), moved)).toEqual([
      "repositories.repo-1.path",
      "repositories.repo-1.worktrees.wt-1.path",
    ]);
    expect(
      reconcileInventoryWrite({ existing: inventory(), incoming: moved, allowExecConfig: false }),
    ).toMatchObject({
      ok: false,
      kind: "forbidden",
      execEdits: ["repositories.repo-1.path", "repositories.repo-1.worktrees.wt-1.path"],
    });

    const withNewWorktree = inventory();
    withNewWorktree.repositories[0]!.worktrees.push({
      id: "wt-2",
      name: "wt-2",
      path: "/opt/harness/repo/.worktrees/wt-2",
      labels: [],
    });
    expect(listExecConfigEdits(inventory(), withNewWorktree)).toEqual([
      "repositories.repo-1.worktrees.wt-2.path",
    ]);
    expect(
      reconcileInventoryWrite({
        existing: inventory(),
        incoming: withNewWorktree,
        allowExecConfig: false,
      }),
    ).toMatchObject({
      ok: false,
      kind: "forbidden",
      execEdits: ["repositories.repo-1.worktrees.wt-2.path"],
    });
  });

  it("detects stored executable paths that inventory deletion would erase", () => {
    expect(inventoryHasExecConfig(undefined)).toBe(false);
    expect(inventoryHasExecConfig(emptyHostInventory())).toBe(false);
    expect(
      inventoryHasExecConfig({ repositories: [], providerAccounts: [], setupScript: "" }),
    ).toBe(false);
    expect(inventoryHasExecConfig(inventory())).toBe(true);
    expect(
      inventoryHasExecConfig({ repositories: [], providerAccounts: [], allowedRoots: ["/opt"] }),
    ).toBe(true);
    expect(
      inventoryHasExecConfig({
        repositories: [
          {
            id: "repo-1",
            path: "/opt/harness/repo",
            defaultBranch: "main",
            terminalHookScript: "/opt/harness/hooks/done.sh",
            worktrees: [],
          },
        ],
        providerAccounts: [],
      }),
    ).toBe(true);
    expect(
      inventoryHasExecConfig({
        repositories: [
          {
            id: "repo-1",
            path: "/opt/harness/repo",
            defaultBranch: "main",
            worktrees: [
              {
                id: "wt-1",
                name: "wt-1",
                path: "/opt/harness/repo/wt-1",
                labels: [],
                setupScript: "pnpm build",
              },
            ],
          },
        ],
        providerAccounts: [],
      }),
    ).toBe(true);
  });

  it("names each changed exec-config field", () => {
    expect(
      listExecConfigEdits(inventory(), {
        setupScript: "new",
        allowedRoots: ["/tmp"],
        repositories: [
          {
            id: "repo-1",
            path: "/opt/harness/repo",
            defaultBranch: "main",
            setupScript: "other",
            terminalHookScript: "/opt/harness/hooks/new.sh",
            worktrees: [
              {
                id: "wt-1",
                name: "wt-1",
                path: "/opt/harness/repo/.worktrees/wt-1",
                labels: [],
                setupScript: "other wt",
              },
            ],
          },
        ],
        providerAccounts: [],
      }),
    ).toEqual([
      "setupScript",
      "allowedRoots",
      "repositories.repo-1.setupScript",
      "repositories.repo-1.terminalHookScript",
      "repositories.repo-1.worktrees.wt-1.setupScript",
    ]);
  });

  it("restores omitted exec-config and keeps present keys", () => {
    const preserved = preserveHostExecConfig(
      {
        repositories: [
          {
            id: "repo-1",
            path: "/new",
            defaultBranch: "dev",
            worktrees: [
              {
                id: "wt-1",
                name: "wt-1",
                path: "/new/wt",
                labels: ["ci"],
              },
            ],
          },
        ],
        providerAccounts: [],
      },
      inventory(),
    );
    expect(preserved.setupScript).toBe("source ~/.zshrc");
    expect(preserved.allowedRoots).toEqual(["/opt/harness"]);
    expect(preserved.repositories[0]?.path).toBe("/new");
    expect(preserved.repositories[0]?.setupScript).toBe("pnpm install");
    expect(preserved.repositories[0]?.terminalHookScript).toBe("/opt/harness/hooks/done.sh");
    expect(preserved.repositories[0]?.worktrees[0]?.setupScript).toBe("pnpm build");
    expect(preserved.repositories[0]?.worktrees[0]?.path).toBe("/new/wt");
    const overlay = preserveHostExecConfig(
      { ...emptyHostInventory(), setupScript: "new host" },
      inventory(),
    );
    expect(overlay.setupScript).toBe("new host");
    expect(overlay.allowedRoots).toEqual(["/opt/harness"]);
    const withoutExec = preserveHostExecConfig(
      {
        repositories: [
          {
            id: "new-repo",
            path: "/new",
            defaultBranch: "main",
            terminalHookScript: "ignore",
            worktrees: [{ id: "new-wt", name: "new-wt", path: "/new/wt", labels: [] }],
          },
        ],
        providerAccounts: [],
      },
      { repositories: [], providerAccounts: [] },
    );
    expect(withoutExec).not.toHaveProperty("setupScript");
    expect(withoutExec).not.toHaveProperty("allowedRoots");
    expect(withoutExec.repositories[0]?.terminalHookScript).toBe("ignore");
    expect(withoutExec.repositories[0]?.worktrees[0]).not.toHaveProperty("setupScript");
  });

  it("handles sparse inventories and explicit blank nested values", () => {
    const sparse: HostInventory = {
      repositories: [
        {
          id: "repo-1",
          path: "/opt/harness/repo",
          defaultBranch: "main",
          worktrees: [
            {
              id: "wt-1",
              name: "wt-1",
              path: "/opt/harness/repo/wt-1",
              labels: [],
            },
          ],
        },
      ],
      providerAccounts: [],
    };
    const patched = applyHostExecConfig(sparse, {
      repositories: [{ id: "repo-1", worktrees: [{ id: "wt-1", setupScript: "echo wt" }] }],
    });
    expect(patched.repositories[0]?.worktrees[0]?.setupScript).toBe("echo wt");
    expect(patched).not.toHaveProperty("allowedRoots");
    expect(patched).not.toHaveProperty("requiredEnvironment");
    const withEnvironment = applyHostExecConfig(
      { ...sparse, requiredEnvironment: ["TOKEN"] },
      { repositories: [{ id: "repo-1" }] },
    );
    expect(withEnvironment.requiredEnvironment).toEqual(["TOKEN"]);

    const windows: HostInventory = {
      ...sparse,
      repositories: [
        {
          ...sparse.repositories[0]!,
          path: "C:\\harness\\repo",
          terminalHookScript: "C:\\harness\\hooks\\done.cmd",
        },
      ],
    };
    expect(
      reconcileInventoryWrite({ existing: windows, incoming: windows, allowExecConfig: false }),
    ).toMatchObject({ ok: true });
    expect(preserveHostExecConfig(sparse, sparse).repositories[0]).not.toHaveProperty(
      "terminalHookScript",
    );

    const cleared = preserveHostExecConfig(
      {
        setupScript: "",
        allowedRoots: [],
        repositories: [
          {
            ...sparse.repositories[0]!,
            setupScript: "",
            terminalHookScript: "",
            worktrees: [{ ...sparse.repositories[0]!.worktrees[0]!, setupScript: "" }],
          },
        ],
        providerAccounts: [],
      },
      sparse,
    );
    expect(cleared).not.toHaveProperty("setupScript");
    expect(cleared.allowedRoots).toEqual([]);
    expect(cleared.repositories[0]).not.toHaveProperty("setupScript");
    expect(cleared.repositories[0]).not.toHaveProperty("terminalHookScript");
    expect(cleared.repositories[0]?.worktrees[0]).not.toHaveProperty("setupScript");
  });

  it("rejects exec-config edits without the capability and applies them with it", () => {
    const incoming: HostInventory = { ...inventory(), setupScript: "pwn" };
    expect(
      reconcileInventoryWrite({ existing: inventory(), incoming, allowExecConfig: false }),
    ).toEqual({
      ok: false,
      error: "fleet:exec-config is required to change setup scripts or executable paths",
      execEdits: ["setupScript"],
      kind: "forbidden",
    });
    expect(
      reconcileInventoryWrite({ existing: inventory(), incoming, allowExecConfig: true }),
    ).toMatchObject({ ok: true, inventory: incoming, execEdits: ["setupScript"] });
    const omitted = reconcileInventoryWrite({
      existing: inventory(),
      incoming: {
        repositories: [
          {
            id: "repo-1",
            path: "/opt/harness/repo",
            defaultBranch: "main",
            worktrees: [
              {
                id: "wt-1",
                name: "wt-1",
                path: "/opt/harness/repo/.worktrees/wt-1",
                labels: [],
              },
            ],
          },
        ],
        providerAccounts: [],
      },
      allowExecConfig: true,
    });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect(omitted.execEdits).toEqual([]);
      expect(omitted.inventory.setupScript).toBe("source ~/.zshrc");
      expect(omitted.inventory.allowedRoots).toEqual(["/opt/harness"]);
      expect(omitted.inventory.repositories[0]?.setupScript).toBe("pnpm install");
      expect(omitted.inventory.repositories[0]?.terminalHookScript).toBe(
        "/opt/harness/hooks/done.sh",
      );
      expect(omitted.inventory.repositories[0]?.worktrees[0]?.setupScript).toBe("pnpm build");
    }
    const ordinary: HostInventory = {
      repositories: [
        {
          id: "repo-1",
          path: "/new",
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/new/wt", labels: [] }],
        },
      ],
      providerAccounts: [],
    };
    const blocked = reconcileInventoryWrite({
      existing: inventory(),
      incoming: ordinary,
      allowExecConfig: false,
    });
    expect(blocked).toMatchObject({
      ok: false,
      kind: "forbidden",
      execEdits: ["repositories.repo-1.path", "repositories.repo-1.worktrees.wt-1.path"],
    });
  });

  it("detects clears and removal of exec-config-bearing subtrees from the full state", () => {
    const cleared = {
      repositories: [],
      providerAccounts: [],
      allowedRoots: [],
    } satisfies HostInventory;
    expect(listExecConfigEdits(inventory(), cleared)).toEqual([
      "setupScript",
      "allowedRoots",
      "repositories.repo-1.setupScript",
      "repositories.repo-1.terminalHookScript",
      "repositories.repo-1.worktrees.wt-1.setupScript",
    ]);
    expect(
      reconcileInventoryWrite({ existing: inventory(), incoming: cleared, allowExecConfig: false }),
    ).toMatchObject({ ok: false, kind: "forbidden" });
  });

  it("canonicalizes an explicit blank worktree override as a privileged deletion", () => {
    const base = inventory();
    const incoming: HostInventory = {
      ...base,
      repositories: [
        {
          ...base.repositories[0]!,
          worktrees: [{ ...base.repositories[0]!.worktrees[0]!, setupScript: "" }],
        },
      ],
    };
    expect(
      reconcileInventoryWrite({ existing: base, incoming, allowExecConfig: false }),
    ).toMatchObject({
      ok: false,
      kind: "forbidden",
      execEdits: ["repositories.repo-1.worktrees.wt-1.setupScript"],
    });
    const allowed = reconcileInventoryWrite({ existing: base, incoming, allowExecConfig: true });
    expect(allowed).toMatchObject({ ok: true });
    if (allowed.ok) {
      expect(allowed.inventory.repositories[0]?.worktrees[0]).not.toHaveProperty("setupScript");
    }
  });

  it("permits an unchanged legacy relative hook but rejects a new or changed one", () => {
    const legacy = inventory();
    legacy.repositories[0]!.terminalHookScript = "./hook.sh";
    expect(
      reconcileInventoryWrite({ existing: legacy, incoming: legacy, allowExecConfig: false }),
    ).toMatchObject({ ok: true, execEdits: [] });

    const changed: HostInventory = {
      ...legacy,
      repositories: [{ ...legacy.repositories[0]!, terminalHookScript: "./replacement.sh" }],
    };
    expect(
      reconcileInventoryWrite({ existing: legacy, incoming: changed, allowExecConfig: true }),
    ).toMatchObject({
      ok: false,
      kind: "validation",
      error: "repository.repo-1.terminalHookScript must be an absolute path",
    });
  });

  it("fences unchanged legacy relative hooks when resolution paths move", () => {
    const legacy = inventory();
    legacy.repositories[0]!.terminalHookScript = "./hook.sh";
    const movedRepository: HostInventory = {
      ...legacy,
      repositories: [
        {
          ...legacy.repositories[0]!,
          path: "/opt/other/repo",
          worktrees: [
            { ...legacy.repositories[0]!.worktrees[0]!, path: "/opt/other/repo/.worktrees/wt-1" },
          ],
        },
      ],
    };
    expect(
      reconcileInventoryWrite({
        existing: legacy,
        incoming: movedRepository,
        allowExecConfig: false,
      }),
    ).toMatchObject({
      ok: false,
      kind: "forbidden",
      error: "fleet:exec-config is required to change setup scripts or executable paths",
    });
    expect(
      reconcileInventoryWrite({
        existing: legacy,
        incoming: movedRepository,
        allowExecConfig: true,
      }),
    ).toMatchObject({ ok: true });

    const addedWorktree: HostInventory = {
      ...legacy,
      repositories: [
        {
          ...legacy.repositories[0]!,
          worktrees: [
            ...legacy.repositories[0]!.worktrees,
            { id: "wt-2", name: "wt-2", path: "/opt/harness/repo/.worktrees/wt-2", labels: [] },
          ],
        },
      ],
    };
    expect(
      reconcileInventoryWrite({
        existing: legacy,
        incoming: addedWorktree,
        allowExecConfig: false,
      }),
    ).toMatchObject({ ok: false, kind: "forbidden" });

    const absoluteReplacement: HostInventory = {
      ...legacy,
      repositories: [{ ...legacy.repositories[0]!, terminalHookScript: "/opt/new-hook.sh" }],
    };
    expect(
      reconcileInventoryWrite({
        existing: legacy,
        incoming: absoluteReplacement,
        allowExecConfig: true,
      }),
    ).toMatchObject({ ok: true });
  });

  it("fences foreign-platform hook spellings when their host base moves", () => {
    const legacy = inventory();
    legacy.repositories[0]!.terminalHookScript = "C:\\hooks\\done.cmd";
    const moved: HostInventory = {
      ...legacy,
      repositories: [
        {
          ...legacy.repositories[0]!,
          worktrees: [
            { ...legacy.repositories[0]!.worktrees[0]!, path: "/opt/other/.worktrees/wt-1" },
          ],
        },
      ],
    };
    expect(
      reconcileInventoryWrite({ existing: legacy, incoming: moved, allowExecConfig: false }),
    ).toMatchObject({ ok: false, kind: "forbidden" });
    expect(
      reconcileInventoryWrite({ existing: legacy, incoming: moved, allowExecConfig: true }),
    ).toMatchObject({ ok: true });
  });

  it("rejects duplicate repository and worktree IDs before reconciliation", () => {
    const duplicateRepository = inventory();
    duplicateRepository.repositories.push({ ...duplicateRepository.repositories[0]! });
    expect(
      reconcileInventoryWrite({
        existing: inventory(),
        incoming: duplicateRepository,
        allowExecConfig: false,
      }),
    ).toMatchObject({ ok: false, kind: "validation", error: "duplicate repository repo-1" });

    const duplicateWorktree = inventory();
    duplicateWorktree.repositories[0]!.worktrees.push({
      ...duplicateWorktree.repositories[0]!.worktrees[0]!,
    });
    expect(
      reconcileInventoryWrite({
        existing: inventory(),
        incoming: duplicateWorktree,
        allowExecConfig: false,
      }),
    ).toMatchObject({ ok: false, kind: "validation", error: "duplicate worktree wt-1" });
  });

  it("rejects duplicate IDs already present in stored inventory", () => {
    const existing = inventory();
    existing.repositories.push({ ...existing.repositories[0]! });
    expect(
      reconcileInventoryWrite({
        existing,
        incoming: inventory(),
        allowExecConfig: true,
      }),
    ).toMatchObject({
      ok: false,
      kind: "validation",
      error: "existing inventory: duplicate repository repo-1",
    });
  });
});
