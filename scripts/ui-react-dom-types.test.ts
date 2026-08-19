import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const uiPkgUrl = new URL("../modules/ui/package.json", import.meta.url);
const uiPkg = JSON.parse(readFileSync(uiPkgUrl, "utf8")) as {
  scripts?: { typecheck?: string };
  devDependencies?: Record<string, string>;
};

describe("@auto-harness/ui react-dom/client types", () => {
  it("declares @types/react-dom and a typecheck script", () => {
    expect(uiPkg.devDependencies?.["@types/react-dom"]).toMatch(/^\^19\./);
    expect(uiPkg.scripts?.typecheck).toBe("tsc --noEmit");
  });

  it("resolves react-dom/client and its declaration file from modules/ui", () => {
    const requireFromUi = createRequire(uiPkgUrl);
    expect(requireFromUi.resolve("react-dom/client")).toMatch(/react-dom[/\\]client\.js$/);

    const typesPkg = requireFromUi.resolve("@types/react-dom/package.json");
    const clientDts = join(dirname(typesPkg), "client.d.ts");
    expect(existsSync(clientDts)).toBe(true);
    expect(readFileSync(clientDts, "utf8")).toContain("createRoot");
  });

  it("documents the worktree node_modules typecheck trap", () => {
    const docs = readFileSync(new URL("../docs/local-development.md", import.meta.url), "utf8");
    expect(docs).toContain("react-dom/client");
    expect(docs).toContain("TS7016");
  });
});
