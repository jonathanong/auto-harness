import type { Dir } from "node:fs";
import { opendir } from "node:fs/promises";

export class SessionOutputAttemptPager {
  private directory: Dir | undefined;
  private pendingName: string | undefined;
  private readPromise: Promise<{ names: string[]; more: boolean }> | undefined;
  private closePromise: Promise<void> | undefined;

  async readPage(path: string, limit: number): Promise<{ names: string[]; more: boolean }> {
    while (this.closePromise || this.readPromise) {
      if (this.closePromise) await this.closePromise;
      else await this.readPromise?.catch(() => undefined);
    }
    const operation = this.readPageInternal(path, limit);
    this.readPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.readPromise === operation) this.readPromise = undefined;
    }
  }

  private async readPageInternal(
    path: string,
    limit: number,
  ): Promise<{ names: string[]; more: boolean }> {
    if (!this.directory) {
      try {
        this.directory = await opendir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { names: [], more: false };
        throw error;
      }
    }
    const directory = this.directory;
    const names: string[] = [];
    if (this.pendingName !== undefined) {
      names.push(this.pendingName);
      this.pendingName = undefined;
    }
    try {
      while (names.length < limit) {
        const entry = await directory.read();
        if (!entry) {
          await this.closeCurrent();
          return { names, more: false };
        }
        names.push(entry.name);
      }
      const next = await directory.read();
      if (!next) {
        await this.closeCurrent();
        return { names, more: false };
      }
      this.pendingName = next.name;
      return { names, more: true };
    } catch (error) {
      await this.closeCurrent();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    const operation = (async () => {
      await this.readPromise?.catch(() => undefined);
      await this.closeCurrent();
    })();
    this.closePromise = operation;
    try {
      await operation;
    } finally {
      if (this.closePromise === operation) this.closePromise = undefined;
    }
  }

  private async closeCurrent(): Promise<void> {
    const directory = this.directory;
    this.directory = undefined;
    this.pendingName = undefined;
    if (directory) await directory.close();
  }
}
