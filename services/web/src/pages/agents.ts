import type { IncomingMessage, ServerResponse } from "node:http";

import { escapeHtml, layout, readBody, send, simplePage } from "../html.ts";

export async function handleAgentsGet(res: ServerResponse, apiBaseUrl: string): Promise<void> {
  const r = await fetch(`${apiBaseUrl}/api/v1/agents`);
  const data = (await r.json()) as { items?: Array<Record<string, unknown>> };
  const rows = (data.items ?? [])
    .map(
      (a) =>
        `<tr><td>${escapeHtml(String(a.agentId))}</td><td>${escapeHtml(String(a.online))}</td><td>${escapeHtml(JSON.stringify(a.commandProfiles ?? []))}</td>
              <td><form method="post" action="/agents/drain" style="display:inline">
                <input type="hidden" name="agentId" value="${escapeHtml(String(a.agentId))}"/>
                <button type="submit">Drain</button>
              </form></td></tr>`,
    )
    .join("");
  send(
    res,
    200,
    layout(
      "Agents",
      `<h1>Agents</h1>
          <table><tr><th>agentId</th><th>online</th><th>profiles</th><th></th></tr>${rows || "<tr><td colspan=4>(none)</td></tr>"}</table>`,
    ),
  );
}

export async function handleAgentsDrainPost(
  req: IncomingMessage,
  res: ServerResponse,
  apiBaseUrl: string,
): Promise<void> {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const agentId = params.get("agentId") ?? "";
  const r = await fetch(`${apiBaseUrl}/api/v1/agents/drain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  const text = await r.text();
  send(
    res,
    r.status,
    simplePage(
      `<p class="${r.ok ? "ok" : "err"}">${r.ok ? "Drain requested" : "Drain failed"}</p><pre>${escapeHtml(text)}</pre><p><a href="/agents">Back</a></p>`,
    ),
  );
}
