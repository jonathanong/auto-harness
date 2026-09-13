import { afterEach, expect, it, vi } from "vitest";

import { fetchHostInventory } from "./bootstrap.ts";
import {
  FakeSocket,
  register,
  registered,
  transportFor,
} from "../test-helpers/ws-transport-test-helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("uses the platform fetch when no bootstrap fetch override is supplied", async () => {
  const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    fetchHostInventory({ hostId: "host/one", apiUrl: "http://example.test" }),
  ).resolves.toMatchObject({ hostId: "host/one", repositories: [] });
  expect(fetchMock).toHaveBeenCalledWith("http://example.test/api/v1/hosts/host%2Fone/inventory", {
    headers: { accept: "application/json" },
  });
});

it("does not deliver control frames after the transport closes", async () => {
  const sockets: FakeSocket[] = [];
  const received: unknown[] = [];
  const transport = transportFor(sockets);
  transport.onMessage((message) => received.push(message));
  const socket = sockets[0]!;
  socket.open();
  await transport.send(register());
  socket.server(registered());
  await transport.registered;

  transport.close();
  socket.server({
    type: "session:assign",
    sessionId: "late-session",
    attemptId: "late-attempt",
    repositoryId: "repo",
    prompt: "prompt",
    resolvedArgv: ["echo", "late"],
    timeout: 1,
    worktreeId: "worktree",
    assignedAt: "now",
  });

  expect(received).toEqual([]);
});

it("ignores malformed acknowledgements even after registration", async () => {
  const sockets: FakeSocket[] = [];
  const received: unknown[] = [];
  const transport = transportFor(sockets);
  transport.onMessage((message) => received.push(message));
  const socket = sockets[0]!;
  socket.open();
  await transport.send(register());
  socket.server(registered());
  await transport.registered;

  socket.server({ type: "session:acknowledged", sessionId: "", attemptId: "attempt" });
  socket.server({ type: "session:cancel", sessionId: "session", attemptId: "" });
  socket.server({
    type: "session:status-acknowledged",
    sessionId: "session",
    retryAccepted: "yes",
  });

  expect(received).toEqual([]);
  transport.close();
});
