/** Keeps validation responses safe when an unexpected non-Error is thrown. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
