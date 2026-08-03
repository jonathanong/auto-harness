import type { IncomingMessage, ServerResponse } from "node:http";

import { escapeHtml, layout, readBody, send, simplePage } from "../html.ts";

export async function handleRepositoriesGet(
  res: ServerResponse,
  apiBaseUrl: string,
): Promise<void> {
  const r = await fetch(`${apiBaseUrl}/api/v1/repositories`);
  const data = (await r.json()) as { items?: Array<Record<string, unknown>> };
  const rows = (data.items ?? [])
    .map(
      (repo) =>
        `<tr><td>${escapeHtml(String(repo.id))}</td><td>${escapeHtml(String(repo.name))}</td><td>${escapeHtml(String(repo.url))}</td><td>${escapeHtml(String(repo.defaultBranch ?? ""))}</td></tr>`,
    )
    .join("");
  send(
    res,
    200,
    layout(
      "Repositories",
      `<h1>Repositories</h1>
          <table><tr><th>id</th><th>name</th><th>url</th><th>defaultBranch</th></tr>${rows || "<tr><td colspan=4>(none)</td></tr>"}</table>
          <h2>Add repository</h2>
          <form method="post" action="/repositories">
            <label>id (optional) <input name="id"/></label>
            <label>name <input name="name" required/></label>
            <label>url / path <input name="url" required/></label>
            <label>defaultBranch <input name="defaultBranch" value="main"/></label>
            <label>setupScript <input name="setupScript"/></label>
            <label>terminalHookScript <input name="terminalHookScript"/></label>
            <button type="submit">Create repository</button>
          </form>`,
    ),
  );
}

export async function handleRepositoriesPost(
  req: IncomingMessage,
  res: ServerResponse,
  apiBaseUrl: string,
): Promise<void> {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const body: Record<string, string> = {
    name: params.get("name") ?? "",
    url: params.get("url") ?? "",
  };
  if (params.get("id")) body.id = params.get("id")!;
  if (params.get("defaultBranch")) body.defaultBranch = params.get("defaultBranch")!;
  if (params.get("setupScript")) body.setupScript = params.get("setupScript")!;
  if (params.get("terminalHookScript")) body.terminalHookScript = params.get("terminalHookScript")!;
  const r = await fetch(`${apiBaseUrl}/api/v1/repositories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    send(
      res,
      r.status,
      simplePage(`<p class="err">${escapeHtml(text)}</p><p><a href="/repositories">Back</a></p>`),
    );
    return;
  }
  send(
    res,
    201,
    simplePage(
      `<p class="ok">Repository created</p><pre>${escapeHtml(text)}</pre><p><a href="/repositories">Back</a></p>`,
    ),
  );
}
