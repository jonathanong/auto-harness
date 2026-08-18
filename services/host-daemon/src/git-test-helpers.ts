import type { ProcessRunner } from "./executor.ts";

export function scripted(
  responses: Array<{
    match: string[];
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }>,
): ProcessRunner {
  // Consume matching entries in order so the same argv can return different
  // results on successive calls (e.g. rev-parse fails then succeeds after fetch).
  const queue = [...responses];
  return {
    async run(opts) {
      const idx = queue.findIndex((r) =>
        r.match.every((m, i) => opts.argv[i + 1] === m || m === "*"),
      );
      if (idx < 0) {
        throw new Error(`unexpected git ${opts.argv.slice(1).join(" ")}`);
      }
      const [hit] = queue.splice(idx, 1);
      if (!hit) throw new Error("unreachable: splice at a matched index always returns an entry");
      if (hit.stdout) {
        opts.onChunk({ stream: "stdout", data: hit.stdout });
      }
      if (hit.stderr) {
        opts.onChunk({ stream: "stderr", data: hit.stderr });
      }
      return { exitCode: hit.exitCode, timedOut: false, signal: null };
    },
  };
}
