import { readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// Without a loading.tsx on the route, Next keeps the previous page on screen until the
// new server render finishes, so a slow page makes a working link look dead.
const APP = dirname(fileURLToPath(import.meta.url));
// Routes that render without API data, so navigating to them is never slow.
const EXEMPT = new Set<string>();

function pageDirs(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const here = entries.some((e) => e.isFile() && e.name === "page.tsx") ? [dir] : [];
  return [
    ...here,
    ...entries.filter((e) => e.isDirectory()).flatMap((e) => pageDirs(join(dir, e.name))),
  ];
}

const routes = pageDirs(APP)
  .map((dir) => relative(APP, dir) || ".")
  .filter((route) => !EXEMPT.has(route));

describe("host-pane route loading boundaries", () => {
  it.each(routes)("%s has a loading.tsx that renders a busy state", async (route) => {
    const file = join(APP, route, "loading.tsx");
    expect(existsSync(file), `add src/app/${route}/loading.tsx`).toBe(true);
    const { default: Loading } = (await import(pathToFileURL(file).href)) as {
      default: ComponentType;
    };
    expect(renderToStaticMarkup(<Loading />)).toContain('aria-busy="true"');
  });
});
