import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { createWsTransport } from "./ws-transport.ts";

export class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  readonly sent: Array<Record<string, unknown>> = [];
  throwNext = false;
  failNext: Error | undefined;
  delayNext = false;
  private delayed: (() => void) | undefined;

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  server(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }

  send(payload: string, done?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("sync write failed");
    }
    const error = this.failNext;
    this.failNext = undefined;
    const finish = () => done?.(error);
    if (this.delayNext) {
      this.delayNext = false;
      this.delayed = finish;
    } else {
      finish();
    }
  }

  finishWrite(): void {
    this.delayed?.();
    this.delayed = undefined;
  }
}

export function transportFor(sockets: FakeSocket[]) {
  return createWsTransport({
    url: "ws://fake.test/ws",
    hostId: "a1",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
}
