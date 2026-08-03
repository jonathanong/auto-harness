import type { IncomingMessage, ServerResponse } from "node:http";

import { escapeHtml, layout, readBody, send, simplePage } from "../html.ts";

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
      "Agents",
      `<h1>Agents</h1>
          <table><tr><th>agentId</th><th>online</th><th>profiles</th><th>host config</th><th></th></tr>${rows}${configuredOnly || ""}${!rows && !configuredOnly ? "<tr><td colspan=5>(none)</td></tr>" : ""}</table>
          <h2>Configure agent host inventory</h2>
          <p>Agent process only needs <code>HARNESS_AGENT_ID</code>, <code>HARNESS_API_URL</code>, <code>HARNESS_API_KEY</code>. Paths and command profiles are set here.</p>
          <form method="post" action="/agents/config">
            <label>agentId <input name="agentId" required placeholder="local-1"/></label>
            <label>host config JSON
              <textarea name="configJson" rows="14" cols="72" required>{
  "repositories": [{
    "id": "demo",
    "path": "/ABS/PATH/TO/REPO",
    "defaultBranch": "main",
    "worktrees": [{ "id": "wt-1", "path": "/ABS/PATH/TO/REPO/.worktrees/wt-1", "labels": ["echo"] }]
  }],
  "commandProfiles": {
    "echo-prompt": { "argv": ["echo"], "appendPrompt": true }
  }
}</textarea>
            </label>
            <button type="submit">Save host config</button>
          </form>`,
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

export async function handleAgentsConfigPost(
  req: IncomingMessage,
  res: ServerResponse,
  apiBaseUrl: string,
): Promise<void> {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const agentId = params.get("agentId") ?? "";
  const configJson = params.get("configJson") ?? "";
  let body: unknown;
  try {
    body = JSON.parse(configJson) as unknown;
  } catch {
    send(res, 400, simplePage(`<p class="err">Invalid JSON</p><p><a href="/agents">Back</a></p>`));
    return;
  }
  const r = await fetch(`${apiBaseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    send(
      res,
      r.status,
      simplePage(`<p class="err">${escapeHtml(text)}</p><p><a href="/agents">Back</a></p>`),
    );
    return;
  }
  send(
    res,
    200,
    simplePage(
      `<p class="ok">Host config saved for ${escapeHtml(agentId)}</p><pre>${escapeHtml(text)}</pre><p><a href="/agents">Back</a></p>`,
    ),
  );
}
