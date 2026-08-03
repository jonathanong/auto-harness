import { startLocalServer } from "../services/api/src/local-server.ts";

const port = 17556;
const server = await startLocalServer({ port });
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositoryId: "demo",
      prompt: "hi",
      commandProfile: "echo-prompt",
      timeout: 30,
      ref: "main",
    }),
  });
  const text = await res.text();
  console.log(JSON.stringify({ status: res.status, body: JSON.parse(text) }, null, 2));
  if (res.status !== 201) {
    process.exitCode = 1;
  }
} finally {
  await server.close();
}
