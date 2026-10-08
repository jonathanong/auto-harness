import type { Dir } from "node:fs";
import { opendir } from "node:fs/promises";

export class SessionOutputAttemptPager {
  private directory: Dir | undefined;
  private pendingName: string | undefined;

  async readPage(path: string, limit: number): Promise<{ names: string[]; more: boolean }> {
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
          await this.close();
          return { names, more: false };
        }
        names.push(entry.name);
      }
      const next = await directory.read();
      if (!next) {
        await this.close();
        return { names, more: false };
      }
      this.pendingName = next.name;
      return { names, more: true };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const directory = this.directory;
    this.directory = undefined;
    this.pendingName = undefined;
    await directory?.close().catch(() => undefined);
  }
}
