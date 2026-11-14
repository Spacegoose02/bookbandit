import { useEffect, useState } from "react";

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", cb: () => void): void;
}
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } };

/**
 * Keeps the screen on while `active` (Screen Wake Lock API). Browsers drop the lock when the tab
 * is hidden, so it is taken again whenever the page becomes visible. Returns whether it's held.
 */
export function useWakeLock(active: boolean): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const wl = (navigator as WakeLockNavigator).wakeLock;
    if (!active || !wl) return;
    let lock: WakeLockSentinelLike | null = null;
    let stopped = false;

    const take = async () => {
      if (stopped || document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        lock = await wl.request("screen");
        if (stopped) {
          void lock.release();
          return;
        }
        setHeld(true);
        lock.addEventListener("release", () => setHeld(false));
      } catch {
        // Denied (battery saver, not allowed in this frame): the page still works.
        setHeld(false);
      }
    };
    void take();
    const onVisible = () => void take();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
      setHeld(false);
    };
  }, [active]);

  return held;
}
