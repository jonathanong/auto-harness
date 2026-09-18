import { runHostIdPostAction } from "./host-post-action.js";

/** `POST /hosts/drain` with `{ hostId }` in the body. */
export async function runHostDrain(argv, io) {
  return runHostIdPostAction(argv, io, {
    commandName: "drain",
    path: "/hosts/drain",
    onSuccess: (result, hostId, flags) => {
      if (flags["--json"]) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      const runningSessionIds = result?.runningSessionIds ?? [];
      io.stdout.write(
        `host ${hostId} is draining (${runningSessionIds.length} session(s) still running)\n`,
      );
      if (runningSessionIds.length > 0) {
        io.stdout.write(`${runningSessionIds.map((id) => `  ${id}`).join("\n")}\n`);
      }
    },
  });
}
