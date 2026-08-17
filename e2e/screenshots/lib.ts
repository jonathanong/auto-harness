import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";

import { CONTROL_PORT, HOST_PANE_PORT } from "../harness-endpoints.ts";

/**
 * Screenshot specs run standalone (see docs/e2e.md — "Design-review screenshots"), not through
 * the `control`/`host-pane` Playwright projects, so they navigate with absolute URLs rather than
 * relying on a project `baseURL`: a single spec often needs both apps in one test.
 */
export const CONTROL_BASE = `http://127.0.0.1:${CONTROL_PORT}`;
export const HOST_PANE_BASE = `http://127.0.0.1:${HOST_PANE_PORT}`;

const OUT_ROOT = resolve(import.meta.dirname, "../../docs/screenshots");

/**
 * `HARNESS_SCREENSHOT_TAG` names the output file within `docs/screenshots/<finding>/` — run
 * once as `before` on the pre-fix commit and once as `after` on the fix branch (see
 * docs/e2e.md). Defaults to `current` for an ad hoc single capture.
 */
const TAG = process.env.HARNESS_SCREENSHOT_TAG ?? "current";

/**
 * Captures `docs/screenshots/<finding>/<tag>.png` with motion/caret variance stripped out so a
 * before/after pair diffs cleanly. `finding` is a short kebab-case slug, e.g. `terminal-clipping`.
 */
export async function shot(page: Page, finding: string): Promise<void> {
  const dir = resolve(OUT_ROOT, finding);
  await mkdir(dir, { recursive: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }",
  });
  await page.screenshot({ path: resolve(dir, `${TAG}.png`) });
}
