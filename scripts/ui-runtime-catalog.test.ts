import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUNTIME_PACKAGES = ["next", "react", "react-dom"] as const;
const CATALOG_SPECIFIER = "catalog:";
const CONSUMERS = [
  { path: "modules/ui/package.json", field: "peerDependencies" },
  { path: "services/web/package.json", field: "dependencies" },
  { path: "services/host-pane/package.json", field: "dependencies" },
] as const;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceYaml = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const localDevDocs = readFileSync(new URL("../docs/local-development.md", import.meta.url), "utf8");
const githubDocs = readFileSync(new URL("../docs/github.md", import.meta.url), "utf8");
const agentsGuide = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

function parseDefaultCatalog(source: string): Record<string, string> {
  const block = source.match(/^catalog:\n((?:  \S[^\n]*\n)*)/m);
  if (!block) {
    throw new Error("pnpm-workspace.yaml is missing a default catalog block");
  }
  const entries: Record<string, string> = {};
  for (const line of block[1].split("\n").filter(Boolean)) {
    const match = /^  ([^:]+): (.+)$/.exec(line);
    if (!match) {
      throw new Error(`Unparseable catalog line: ${line}`);
    }
    entries[match[1]] = match[2];
  }
  return entries;
}

function lockfileSection(source: string, heading: string, nextHeading?: string): string {
  const start = source.search(new RegExp(`^${heading}:\\n`, "m"));
  if (start === -1) return "";
  const rest = source.slice(start);
  if (!nextHeading) return rest;
  const end = rest.search(new RegExp(`\\n${nextHeading}:\\n`));
  return end === -1 ? rest : rest.slice(0, end);
}

function identityVersions(source: string, name: string): string[] {
  const packages = lockfileSection(source, "packages", "snapshots");
  const versions = new Set<string>();
  const pattern = new RegExp(`(?:^|\\n)  ${name}@([^(\\s:]+):`, "g");
  for (const match of packages.matchAll(pattern)) {
    versions.add(match[1]);
  }
  return [...versions].toSorted();
}

function importerVersions(source: string, name: string): string[] {
  const importers = lockfileSection(source, "importers", "packages");
  const versions = new Set<string>();
  const pattern = new RegExp(
    `^ {6}${name}:\\n {8}specifier: [^\\n]+\\n {8}version: ([^(\\n]+)`,
    "gm",
  );
  for (const match of importers.matchAll(pattern)) {
    versions.add(match[1]);
  }
  return [...versions].toSorted();
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as Record<string, unknown>;
}

function declaredRuntime(pkg: Record<string, unknown>, field: string): Record<string, string> {
  const block = pkg[field];
  if (!block || typeof block !== "object") {
    throw new Error(`Missing ${field}`);
  }
  return block as Record<string, string>;
}

describe("shared UI runtime catalog", () => {
  it("pins next, react, and react-dom once in the default catalog", () => {
    const catalog = parseDefaultCatalog(workspaceYaml);
    expect(catalog.next).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(catalog.react).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(catalog["react-dom"]).toMatch(/^\^\d+\.\d+\.\d+$/);
  });

  it("makes every UI runtime consumer take those packages from the catalog", () => {
    for (const consumer of CONSUMERS) {
      const declared = declaredRuntime(readJson(consumer.path), consumer.field);
      for (const name of RUNTIME_PACKAGES) {
        expect(declared[name], `${consumer.path} ${consumer.field}.${name}`).toBe(
          CATALOG_SPECIFIER,
        );
      }
    }
  });

  it("does not let any other workspace package.json pin next, react, or react-dom", () => {
    const allowed = new Set(CONSUMERS.map((consumer) => join(...consumer.path.split("/"))));
    const extras: string[] = [];
    for (const workspaceDir of ["actions", "modules", "services"]) {
      for (const pkgDir of readdirSync(join(repoRoot, workspaceDir), { withFileTypes: true })) {
        if (!pkgDir.isDirectory()) continue;
        const relative = join(workspaceDir, pkgDir.name, "package.json");
        if (allowed.has(relative) || !existsSync(join(repoRoot, relative))) continue;
        const pkg = readJson(relative);
        for (const field of [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ]) {
          const block = pkg[field];
          if (!block || typeof block !== "object") continue;
          for (const name of RUNTIME_PACKAGES) {
            if (name in (block as Record<string, unknown>)) {
              extras.push(`${relative} ${field}.${name}`);
            }
          }
        }
      }
    }
    const rootPkg = readJson("package.json");
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const block = rootPkg[field];
      if (!block || typeof block !== "object") continue;
      for (const name of RUNTIME_PACKAGES) {
        if (name in (block as Record<string, unknown>)) {
          extras.push(`package.json ${field}.${name}`);
        }
      }
    }
    expect(extras).toEqual([]);
  });

  it("resolves each catalog runtime package to one lockfile version", () => {
    for (const name of RUNTIME_PACKAGES) {
      expect(identityVersions(lockfile, name), `${name} packages identity`).toHaveLength(1);
      expect(importerVersions(lockfile, name), `${name} importer resolution`).toEqual(
        identityVersions(lockfile, name),
      );
    }
    expect(lockfile).toMatch(/^ {6}next:\n {8}specifier: '?catalog:'?$/m);
    expect(lockfile).toMatch(/^ {6}react:\n {8}specifier: '?catalog:'?$/m);
    expect(lockfile).toMatch(/^ {6}react-dom:\n {8}specifier: '?catalog:'?$/m);
  });

  it("treats two packages identities as a split", () => {
    expect(
      identityVersions(
        [
          "packages:",
          "  next@16.3.2:",
          "  next@16.3.3:",
          "snapshots:",
          "  next@16.3.3(@playwright/test@1.62.1):",
          "",
        ].join("\n"),
        "next",
      ),
    ).toEqual(["16.3.2", "16.3.3"]);
  });

  it("does not treat a packages identity plus its snapshots peer graph as a split", () => {
    expect(
      identityVersions(
        [
          "packages:",
          "  next@16.3.3:",
          "snapshots:",
          "  next@16.3.3(@playwright/test@1.62.1):",
          "",
        ].join("\n"),
        "next",
      ),
    ).toEqual(["16.3.3"]);
  });

  it("documents the catalog pin for Dependabot and local installs", () => {
    expect(agentsGuide).toContain("catalog:");
    expect(agentsGuide).toContain("next");
    expect(localDevDocs).toContain("catalog:");
    expect(localDevDocs).toContain("App Router");
    expect(githubDocs).toContain("default pnpm catalog");
    expect(githubDocs).toContain("catalog:");
  });
});
