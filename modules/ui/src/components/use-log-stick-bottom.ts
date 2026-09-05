import { useEffect, useRef, type RefObject } from "react";

export function useLogStickBottom(
  ref: RefObject<HTMLDivElement | null>,
  key: string,
  enabled: boolean,
): void {
  const stick = useRef(true);
  const primed = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [enabled, ref]);
  useEffect(() => {
    if (!enabled) {
      stick.current = true;
      primed.current = false;
      return;
    }
    if (!primed.current) {
      primed.current = true;
      return;
    }
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [enabled, key, ref]);
}
