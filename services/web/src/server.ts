import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  createHttpApiClient,
  createSessionFromUi,
  validateCreateSessionForm,
} from "./create-session.js";

export type WebServerOptions = {
  port?: number;
  apiBaseUrl?: string;
};

function send(res: ServerResponse, status: number, body: string, type = "text/html"): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
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

/**
 * Minimal Phase 4 local web entry: create-session form + profile dropdown.
 * Profiles and create go to the real API (not free-text commands).
 */
export async function startWebServer(options: WebServerOptions = {}): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const port = options.port ?? 3000;
  const apiBaseUrl = options.apiBaseUrl ?? process.env.HARNESS_API_HTTP ?? "http://127.0.0.1:7420";
  const client = createHttpApiClient(apiBaseUrl);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        send(res, 200, JSON.stringify({ ok: true }), "application/json");
        return;
      }

      if (method === "GET" && (url.pathname === "/" || url.pathname === "/sessions/new")) {
        let profiles: string[] = [];
        let profilesError = "";
        try {
          profiles = await client.listCommandProfiles();
        } catch (err) {
          profilesError = err instanceof Error ? err.message : String(err);
        }
        const optionsHtml =
          profiles.length === 0
            ? `<option value="">(no agent profiles — start an agent)</option>`
            : profiles
                .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
                .join("");
        const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Auto Harness — New session</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}
  label{display:block;margin-top:1rem;font-weight:600}
  input,select,textarea{width:100%;padding:.4rem;margin-top:.25rem}
  button{margin-top:1.25rem;padding:.5rem 1rem}
  .err{color:#a00}
  .ok{color:#060}
</style>
</head>
<body>
  <h1>Create session</h1>
  <p>Command profile is a <strong>dropdown of agent-reported names</strong> (D4) — not free text.</p>
  ${profilesError ? `<p class="err">Could not load profiles: ${escapeHtml(profilesError)}</p>` : ""}
  <form method="post" action="/sessions">
    <label>Repository id <input name="repositoryId" required value="demo"/></label>
    <label>Prompt <textarea name="prompt" required rows="4">hello from web</textarea></label>
    <label>Command profile
      <select name="commandProfile" required>${optionsHtml}</select>
    </label>
    <label>Timeout (seconds) <input name="timeout" type="number" min="1" value="60" required/></label>
    <label>Ref (branch/tag/SHA) <input name="ref" value="main"/></label>
    <button type="submit">Create session</button>
  </form>
</body>
</html>`;
        send(res, 200, html);
        return;
      }

      if (method === "POST" && url.pathname === "/sessions") {
        const raw = await readBody(req);
        const params = new URLSearchParams(raw);
        const availableProfiles = await client.listCommandProfiles().catch(() => [] as string[]);
        const form = {
          repositoryId: params.get("repositoryId") ?? "",
          prompt: params.get("prompt") ?? "",
          commandProfile: params.get("commandProfile") ?? "",
          timeout: Number(params.get("timeout") ?? "0"),
          ref: params.get("ref") || undefined,
          availableProfiles,
        };
        // Validate first so free-text profiles never hit the API
        const validated = validateCreateSessionForm({
          repositoryId: form.repositoryId,
          prompt: form.prompt,
          commandProfile: form.commandProfile,
          timeout: form.timeout,
          availableProfiles,
          ...(form.ref ? { ref: form.ref } : {}),
        });
        if (!validated.ok) {
          send(
            res,
            400,
            `<!DOCTYPE html><html><body><p class="err">${escapeHtml(validated.error)}</p><p><a href="/">Back</a></p></body></html>`,
          );
          return;
        }
        const result = await createSessionFromUi(client, {
          repositoryId: form.repositoryId,
          prompt: form.prompt,
          commandProfile: form.commandProfile,
          timeout: form.timeout,
          availableProfiles,
          ...(form.ref ? { ref: form.ref } : {}),
        });
        if (!result.ok) {
          send(
            res,
            result.status ?? 500,
            `<!DOCTYPE html><html><body><p class="err">${escapeHtml(result.error)}</p><p><a href="/">Back</a></p></body></html>`,
          );
          return;
        }
        send(
          res,
          201,
          `<!DOCTYPE html><html><body>
            <p class="ok">Session created</p>
            <pre>${escapeHtml(JSON.stringify(result.session, null, 2))}</pre>
            <p><a href="/">Create another</a></p>
          </body></html>`,
        );
        return;
      }

      if (method === "POST" && url.pathname === "/api/create-session") {
        // JSON API used by tests — drives real createSessionFromUi
        const raw = await readBody(req);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          send(res, 400, JSON.stringify({ error: "invalid JSON" }), "application/json");
          return;
        }
        const availableProfiles =
          (body.availableProfiles as string[] | undefined) ??
          (await client.listCommandProfiles().catch(() => [] as string[]));
        const result = await createSessionFromUi(client, {
          repositoryId: String(body.repositoryId ?? ""),
          prompt: String(body.prompt ?? ""),
          commandProfile: String(body.commandProfile ?? ""),
          timeout: Number(body.timeout ?? 0),
          availableProfiles,
          ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
        });
        if (!result.ok) {
          send(
            res,
            result.status ?? 400,
            JSON.stringify({ ok: false, error: result.error }),
            "application/json",
          );
          return;
        }
        send(res, 201, JSON.stringify({ ok: true, session: result.session }), "application/json");
        return;
      }

      send(res, 404, "not found", "text/plain");
    })().catch((err) => {
      send(res, 500, String(err), "text/plain");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      resolve();
    });
    server.on("error", reject);
  });

  return {
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function main(argv: string[] = process.argv): Promise<number> {
  const args = argv.slice(2);
  let port = 3000;
  const portIdx = args.indexOf("--port");
  if (portIdx >= 0) {
    port = Number(args[portIdx + 1]);
  }
  return startWebServer({ port }).then((s) => {
    console.log(`Auto Harness web on http://127.0.0.1:${s.port}`);
    return new Promise(() => {
      /* run until killed */
    });
  });
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  void main();
}
