import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";

import { API_BASE, CONTROL_PORT, HOST_PANE_PORT } from "../harness-endpoints.ts";

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

/**
 * Registers a fake host over the real API WebSocket and resolves the first `session:assign` it
 * receives — same fake-host-over-real-socket approach as `e2e/control/live-session-logs.spec.ts`,
 * for specs that need a live session's log stream rather than a bare page load.
 */
export async function connectHost(
  hostId: string,
  repositoryId: string,
  worktreeId: string,
): Promise<{
  socket: WebSocket;
  assignment: Promise<{ sessionId: string; attemptId: string }>;
}> {
  const socket = new WebSocket(API_BASE.replace("http:", "ws:") + "/ws");
  const assignment = new Promise<{ sessionId: string; attemptId: string }>(
    (resolveAssign, reject) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          sessionId?: string;
          attemptId?: string;
        };
        if (message.type === "session:assign" && message.sessionId && message.attemptId) {
          resolveAssign({ sessionId: message.sessionId, attemptId: message.attemptId });
        }
      });
      socket.addEventListener("error", () => reject(new Error("host WebSocket failed")));
    },
  );
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "host:register",
          hostId,
          worktrees: [
            {
              id: worktreeId,
              name: worktreeId,
              repositoryId,
              path: `/tmp/${worktreeId}`,
              labels: [],
            },
          ],
          commandProfiles: [],
        }),
      );
      resolveOpen();
    });
    socket.addEventListener("error", () => reject(new Error("host WebSocket failed")));
  });
  return { socket, assignment };
}

export function logFrame(
  sessionId: string,
  content: string,
  seq: number,
  stream: "stdout" | "system" = "stdout",
): string {
  return JSON.stringify({
    type: "session:log",
    sessionId,
    stream,
    content: `${content}\r\n`,
    timestamp: new Date().toISOString(),
    seq,
  });
}

export async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolveClosed) => {
    socket.addEventListener("close", () => resolveClosed(), { once: true });
    socket.close();
  });
}
