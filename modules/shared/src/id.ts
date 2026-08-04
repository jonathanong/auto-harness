import { v7 as uuidv7 } from "uuid";

/** Opaque, immutable, sortable-by-creation-time id for user-facing entities (repositories, worktrees). */
export function newId(): string {
  return uuidv7();
}
