import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { storytellerApi } from "./api";

const CACHE = "bb-storyteller-on";

/**
 * A kid's home: when a parent switched storyteller mode on for this profile, open the
 * storyteller screen instead of the usual kid home. Remembers the answer per device so a
 * toddler's tablet doesn't flash the bookshelf first.
 */
export function StorytellerGate({ fallback }: { fallback: ReactNode }) {
  const [on, setOn] = useState<boolean | null>(() => {
    try {
      const v = localStorage.getItem(CACHE);
      return v == null ? null : v === "1";
    } catch {
      return null;
    }
  });

  useEffect(() => {
    storytellerApi.screen("me").then(
      (s) => {
        setOn(s.settings.enabled);
        try {
          localStorage.setItem(CACHE, s.settings.enabled ? "1" : "0");
        } catch {
          /* ignore */
        }
      },
      () => setOn(false),
    );
  }, []);

  if (on === null) return <div className="bb-page bb-muted">Loading…</div>;
  return on ? <Navigate to="/storyteller" replace /> : <>{fallback}</>;
}
