import { useCallback, useState } from "react";
import { clampPrefs, DEFAULT_PREFS, KID_PREFS, type ReaderPrefs } from "./readerCss";

/** Text settings are per device (a tablet and a laptop want different sizes). */
export function useReaderPrefs(userId: string, isKid: boolean) {
  const key = `bb-reader-prefs:${userId}`;
  const base = isKid ? KID_PREFS : DEFAULT_PREFS;
  const [prefs, setPrefsState] = useState<ReaderPrefs>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? clampPrefs(JSON.parse(raw) as Partial<ReaderPrefs>, base) : base;
    } catch {
      return base;
    }
  });
  const setPrefs = useCallback(
    (patch: Partial<ReaderPrefs>) =>
      setPrefsState((p) => {
        const next = clampPrefs({ ...p, ...patch }, base);
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      }),
    [key, base],
  );
  return [prefs, setPrefs] as const;
}
