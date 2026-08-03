import type { IncomingMessage, ServerResponse } from "node:http";

import { escapeHtml, layout, readBody, send, simplePage } from "../html.ts";

export type AgentPaneCtx = {
  agentId: string;
  apiBaseUrl: string;
};

/** Agent status: online, profiles, worktrees, recent sessions for this agentId. */
export async function handleAgentPaneHome(res: ServerResponse, ctx: AgentPaneCtx): Promise<void> {
  const { agentId, apiBaseUrl } = ctx;
  const [agentsRes, worktreesRes, sessionsRes, configRes] = await Promise.all([
    fetch(`${apiBaseUrl}/api/v1/agents`),
    fetch(`${apiBaseUrl}/api/v1/worktrees`),
    fetch(`${apiBaseUrl}/api/v1/sessions`),
    fetch(`${apiBaseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/config`),
  ]);
  const agents = (await agentsRes.json()) as { items?: Array<Record<string, unknown>> };
  const worktrees = (await worktreesRes.json()) as { items?: Array<Record<string, unknown>> };
  const sessions = (await sessionsRes.json()) as { items?: Array<Record<string, unknown>> };
  const me = (agents.items ?? []).find((a) => a.agentId === agentId);
  const myWts = (worktrees.items ?? []).filter((w) => w.agentId === agentId);
  const mySessions = (sessions.items ?? []).filter((s) => s.agentId === agentId).slice(0, 20);
  const hasConfig = configRes.ok;
  const configHint = hasConfig
    ? "host config present"
    : "no host config — set it under Host config";

  const wtRows = myWts
    .map(
      (w) =>
        `<tr><td>${escapeHtml(String(w.id))}</td><td>${escapeHtml(String(w.repositoryId))}</td><td>${escapeHtml(String(w.path))}</td><td>${escapeHtml(String(w.status))}</td><td>${escapeHtml(String(w.online))}</td></tr>`,
    )
    .join("");
  const sessRows = mySessions
    .map(
      (s) =>
        `<tr><td>${escapeHtml(String(s.id))}</td><td>${escapeHtml(String(s.status))}</td><td>${escapeHtml(String(s.commandProfile ?? ""))}</td></tr>`,
    )
    .join("");

  send(
    res,
    200,
    layout(
      `Agent ${agentId}`,
      `<h1>Agent pane — ${escapeHtml(agentId)}</h1>
      <p class="banner">This UI is for <strong>one agent host</strong> (<code>HARNESS_AGENT_ID</code>).
      Control plane UI: <code>http://127.0.0.1:7421</code>. API: <code>${escapeHtml(apiBaseUrl)}</code>.</p>
      <p>Online: <strong>${me ? escapeHtml(String(me.online)) : "false (not registered)"}</strong>
      · ${escapeHtml(configHint)}
      · profiles: ${escapeHtml(JSON.stringify(me?.commandProfiles ?? []))}</p>
      <form method="post" action="/drain"><button type="submit">Drain this agent</button></form>
      <h2>Worktrees</h2>
      <table><tr><th>id</th><th>repo</th><th>path</th><th>status</th><th>online</th></tr>${wtRows || "<tr><td colspan=5>(none)</td></tr>"}</table>
      <h2>Recent sessions (this agent)</h2>
      <table><tr><th>id</th><th>status</th><th>profile</th></tr>${sessRows || "<tr><td colspan=3>(none)</td></tr>"}</table>`,
      "agent",
    ),
  );
}

export async function handleAgentPaneConfigGet(
  res: ServerResponse,
  ctx: AgentPaneCtx,
): Promise<void> {
  const { agentId, apiBaseUrl } = ctx;
  const r = await fetch(`${apiBaseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/config`);
  let textarea = `{
  "repositories": [{
    "id": "demo",
    "path": "/ABS/PATH/TO/REPO",
    "defaultBranch": "main",
    "worktrees": [{ "id": "wt-1", "path": "/ABS/PATH/TO/REPO/.worktrees/wt-1", "labels": ["echo"] }]
  }],
  "commandProfiles": {
    "echo-prompt": { "argv": ["echo"], "appendPrompt": true }
  }
}`;
  if (r.ok) {
    const cfg = (await r.json()) as Record<string, unknown>;
    const { agentId: _a, updatedAt: _u, ...rest } = cfg;
    textarea = JSON.stringify(rest, null, 2);
  }
  send(
    res,
    200,
    layout(
      `Host config — ${agentId}`,
      `<h1>Host inventory — ${escapeHtml(agentId)}</h1>
      <p>Repos repos, worktrees, and command profile argv for this agent.
      Stored on the control plane (DynamoDB); the agent process bootstraps on start.</p>
      <form method="post" action="/config">
        <label>host config JSON
          <textarea name="configJson" rows="18" cols="72" required>${escapeHtml(textarea)}</textarea>
        </label>
        <button type="submit">Save host config</button>
      </form>`,
      "agent",
    ),
  );
}

export async function handleAgentPaneConfigPost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AgentPaneCtx,
): Promise<void> {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const configJson = params.get("configJson") ?? "";
  let body: unknown;
  try {
    body = JSON.parse(configJson) as unknown;
  } catch {
    send(
      res,
      400,
      simplePage(`<p class="err">Invalid JSON</p><p><a href="/config">Back</a></p>`, "agent"),
    );
    return;
  }
  const r = await fetch(
    `${ctx.apiBaseUrl}/api/v1/agents/${encodeURIComponent(ctx.agentId)}/config`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const text = await r.text();
  if (!r.ok) {
    send(
      res,
      r.status,
      simplePage(
        `<p class="err">${escapeHtml(text)}</p><p><a href="/config">Back</a></p>`,
        "agent",
      ),
    );
    return;
  }
  send(
    res,
    200,
    simplePage(
      `<p class="ok">Host config saved</p><pre>${escapeHtml(text)}</pre><p><a href="/">Status</a> · <a href="/config">Edit again</a></p>`,
      "agent",
    ),
  );
}

export async function handleAgentPaneDrainPost(
  res: ServerResponse,
  ctx: AgentPaneCtx,
): Promise<void> {
  const r = await fetch(`${ctx.apiBaseUrl}/api/v1/agents/drain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: ctx.agentId }),
  });
  const text = await r.text();
  send(
    res,
    r.status,
    simplePage(
      `<p class="${r.ok ? "ok" : "err"}">${r.ok ? "Drain requested" : "Drain failed"}</p><pre>${escapeHtml(text)}</pre><p><a href="/">Back</a></p>`,
      "agent",
    ),
  );
}
