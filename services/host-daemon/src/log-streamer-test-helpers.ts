import type { LogStreamerTimers } from "./log-streamer.ts";

export type StreamerClock = {
  timers: LogStreamerTimers;
  advance: (ms: number) => void;
};

export function createStreamerClock(): StreamerClock {
  const pending = new Map<number, { due: number; fn: () => void }>();
  let nextId = 1;
  let nowMs = 0;
  return {
    timers: {
      nowMs: () => nowMs,
      setTimeout: (fn, ms) => {
        const id = nextId++;
        pending.set(id, { due: nowMs + Number(ms), fn: fn as () => void });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (id) => {
        pending.delete(id as unknown as number);
      },
    },
    advance(ms: number) {
      nowMs += ms;
      const due = [...pending.entries()]
        .filter(([, timer]) => timer.due <= nowMs)
        .toSorted((left, right) => left[1].due - right[1].due);
      for (const [id, timer] of due) {
        pending.delete(id);
        timer.fn();
      }
    },
  };
}
