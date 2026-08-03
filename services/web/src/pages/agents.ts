import type { IncomingMessage, ServerResponse } from "node:http";

import { escapeHtml, layout, readBody, send, simplePage } from "../html.ts";

/** Control-plane fleet view. Host inventory is edited on the agent pane (:7423). */
export async function handleAgentsGet(res: ServerResponse, apiBaseUrl: string): Promise<void> {
  const [agentsRes, hostsRes] = await Promise.all([
    fetch(`${apiBaseUrl}/api/v1/agents`),
    fetch(`${apiBaseUrl}/api/v1/agent-hosts`),
  ]);
  const agentsData = (await agentsRes.json()) as { items?: Array<Record<string, unknown>> };
  const hostsData = (await hostsRes.json()) as { items?: Array<Record<string, unknown>> };
  const hostById = new Map((hostsData.items ?? []).map((h) => [String(h.agentId), h] as const));
  const rows = (agentsData.items ?? [])
    .map((a) => {
      const id = String(a.agentId);
      const host = hostById.get(id);
      const profiles = host
        ? Object.keys((host.commandProfiles as object) ?? {})
        : (a.commandProfiles ?? []);
      return `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(String(a.online))}</td><td>${escapeHtml(JSON.stringify(profiles))}</td>
              <td>${host ? "yes" : "no"}</td>
              <td><form method="post" action="/agents/drain" style="display:inline">
                <input type="hidden" name="agentId" value="${escapeHtml(id)}"/>
                <button type="submit">Drain</button>
              </form></td></tr>`;
    })
    .join("");
  const configuredOnly = (hostsData.items ?? [])
    .filter((h) => !(agentsData.items ?? []).some((a) => a.agentId === h.agentId))
    .map(
      (h) =>
        `<tr><td>${escapeHtml(String(h.agentId))}</td><td>false</td><td>${escapeHtml(JSON.stringify(Object.keys((h.commandProfiles as object) ?? {})))}</td><td>yes</td><td></td></tr>`,
    )
    .join("");
  send(
    res,
    200,
    layout(
      "Agents — Control plane",
      `<h1>Agents</h1>
          <p class="banner">Fleet view. Host inventory (paths, commandProfiles) is configured on the
          <strong>agent pane</strong> at <code>http://127.0.0.1:7423</code>
          (<code>pnpm local:agent-web</code>).</p>
          <table><tr><th>agentId</th><th>online</th><th>profiles</th><th>host config</th><th></th></tr>${rows}${configuredOnly || ""}${!rows && !configuredOnly ? "<tr><td colspan=5>(none)</td></tr>" : ""}</table>`,
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
