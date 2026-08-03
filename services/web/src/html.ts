import type { IncomingMessage, ServerResponse } from "node:http";

const CONTROL_NAV = `<nav style="margin-bottom:1.5rem">
  <strong>Control plane</strong> ·
  <a href="/">New session</a> ·
  <a href="/sessions">Sessions</a> ·
  <a href="/repositories">Repositories</a> ·
  <a href="/schedules">Schedules</a> ·
  <a href="/agents">Agents</a>
</nav>`;

const AGENT_NAV = `<nav style="margin-bottom:1.5rem">
  <strong>Agent pane</strong> ·
  <a href="/">Status</a> ·
  <a href="/config">Host config</a>
</nav>`;

const BASE_STYLE = `body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}
  label{display:block;margin-top:1rem;font-weight:600}
  input,select,textarea{width:100%;padding:.4rem;margin-top:.25rem;box-sizing:border-box}
  button{margin-top:1.25rem;padding:.5rem 1rem}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid #ccc;padding:.4rem;text-align:left}
  .err{color:#a00}.ok{color:#060} nav a{margin-right:.25rem}
  .banner{background:#f4f4f4;padding:.5rem .75rem;margin-bottom:1rem;border-radius:4px;font-size:.9rem}`;

type UiPane = "control" | "agent";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function send(res: ServerResponse, status: number, body: string, type = "text/html"): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** Full HTML document with pane-specific nav. */
export function layout(title: string, body: string, pane: UiPane = "control"): string {
  const nav = pane === "agent" ? AGENT_NAV : CONTROL_NAV;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>${title}</title>
<style>${BASE_STYLE}</style>
</head>
<body>
  ${nav}
  ${body}
</body>
</html>`;
}

/** Lightweight result page (keeps pane nav). */
export function simplePage(body: string, pane: UiPane = "control"): string {
  const nav = pane === "agent" ? AGENT_NAV : CONTROL_NAV;
  return `<!DOCTYPE html><html><body>${nav}${body}</body></html>`;
}
