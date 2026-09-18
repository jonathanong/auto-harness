import { runHostIdPostAction } from "./host-post-action.js";

/** `POST /hosts/resume` with `{ hostId }` in the body. Idempotent: safe on a host that is not
 * currently draining. */
export async function runHostResume(argv, io) {
  return runHostIdPostAction(argv, io, {
    commandName: "resume",
    path: "/hosts/resume",
    onSuccess: (result, hostId, flags) => {
      if (flags["--json"]) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      io.stdout.write(`host ${hostId} resumed (safe to run even if it was not draining)\n`);
    },
  });
}
