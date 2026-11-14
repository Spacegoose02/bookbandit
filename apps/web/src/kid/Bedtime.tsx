import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import type { BedtimeStatus } from "@bookbandit/shared";
import { isDemo } from "../api/client";
import { useSession } from "../app/session";
import { BARNABY_FACE } from "../brand/Barnaby";
import { rewardsApi } from "./api";
import "./kid.css";

/** How often a kid's tablet asks whether it's bedtime. */
const CHECK_MS = 60_000;

export const wakeTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The kid's bedtime status, checked every minute and whenever the tablet wakes up. */
export function useBedtime(enabled: boolean): BedtimeStatus | null {
  const [status, setStatus] = useState<BedtimeStatus | null>(null);
  const check = useCallback(() => {
    rewardsApi.bedtime().then(setStatus, () => undefined);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    check();
    const t = setInterval(check, CHECK_MS);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, check]);
  return enabled ? status : null;
}

/**
 * Covers every kid screen (the reader too) while it's bedtime. The server refuses book files
 * and reading time at bedtime anyway; this is the friendly face of that. Storyteller profiles
 * keep their bedtime-story screen, which has its own nightly limits.
 */
export function BedtimeScreen() {
  const { me } = useSession();
  const { pathname } = useLocation();
  const kid = !!me?.isKid;
  const status = useBedtime(kid);
  if (!kid || !status || pathname.startsWith("/storyteller") || pathname === "/who") return null;

  if (!status.active) {
    // A gentle heads-up that never covers the page, and never inside the reader.
    if (status.startsInMinutes == null || status.startsInMinutes > 15 || pathname.startsWith("/read/") || pathname === "/") return null;
    return (
      <div className="bb-bedtime-soon" role="status">
        <span aria-hidden>🌙</span> Bedtime in {status.startsInMinutes} minute{status.startsInMinutes === 1 ? "" : "s"}
      </div>
    );
  }

  return (
    <div className="bb-bedtime" role="dialog" aria-modal="true" aria-labelledby="bb-bedtime-title">
      <div className="bb-bedtime-sky" aria-hidden>
        {["✦", "✧", "⋆", "✦", "✧", "⋆", "✦", "✧"].map((s, i) => (
          <span key={i} style={{ ["--i" as string]: i }}>
            {s}
          </span>
        ))}
      </div>
      <div className="bb-bedtime-moon" aria-hidden>
        🌙
      </div>
      <img className="bb-bedtime-barnaby" src={BARNABY_FACE} alt="" />
      <h1 id="bb-bedtime-title" className="bb-bedtime-title">
        Goodnight, {me!.displayName}!
      </h1>
      <p className="bb-bedtime-text">
        It's bedtime. Your books are sleeping too.
        {status.endsAt ? (
          <>
            <br />
            They wake up at <strong>{wakeTime(status.endsAt)}</strong>.
          </>
        ) : null}
      </p>
      {!isDemo && (
        <a href="/who" className="bb-btn bb-btn-big bb-bedtime-switch">
          <span aria-hidden>👋</span> Switch reader
        </a>
      )}
    </div>
  );
}
