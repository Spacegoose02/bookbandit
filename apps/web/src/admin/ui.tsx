/** Small building blocks shared by the admin and family pages. */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CONTENT_RATINGS, RATING_LABELS, type ContentRating } from "@bookbandit/shared";

/** Load data once (and again on reload()). Keeps the last good value while reloading. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load()
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload, setData };
}

/** Wraps an async action with a busy flag and an error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export const SHORT_RATING: Record<ContentRating, string> = {
  kids: "Kids",
  middle_grade: "Middle grade",
  teen: "Teen",
  adult: "Adult",
  explicit: "Explicit",
};

export function RatingPill({ rating, source }: { rating: ContentRating | null; source?: string | null }) {
  return (
    <span className={`bb-rating-pill is-${rating ?? "unrated"}`} title={rating ? RATING_LABELS[rating] : "Unrated: hidden from kids until rated"}>
      {rating ? SHORT_RATING[rating] : "Unrated"}
      {source && source !== "admin" ? <em> · {SOURCE_LABEL[source] ?? source}</em> : null}
    </span>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  folder: "from folder",
  metadata: "from metadata",
  ai: "AI guess",
  keywords: "from genres",
};

/** One-tap rating buttons. */
export function RatingButtons({
  value,
  onPick,
  disabled,
  label = "Rating",
}: {
  value: ContentRating | null;
  onPick: (r: ContentRating) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="bb-rating-buttons" role="group" aria-label={label}>
      {CONTENT_RATINGS.map((r) => (
        <button
          key={r}
          type="button"
          className={`bb-rating-btn is-${r}`}
          aria-pressed={value === r}
          disabled={disabled}
          title={RATING_LABELS[r]}
          onClick={() => onPick(r)}
        >
          {SHORT_RATING[r]}
        </button>
      ))}
    </div>
  );
}

export function Tile({ label, value, hint, to, tone }: { label: string; value: ReactNode; hint?: ReactNode; to?: string; tone?: "warn" }) {
  const body = (
    <>
      <span className="bb-tile-value">{value}</span>
      <span className="bb-tile-label">{label}</span>
      {hint ? <span className="bb-tile-hint">{hint}</span> : null}
    </>
  );
  const cls = `bb-tile${tone ? ` is-${tone}` : ""}`;
  return to ? (
    <Link className={cls} to={to}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bb-admin-card${className ? ` ${className}` : ""}`}>
      {(title || actions) && (
        <header className="bb-admin-card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="bb-admin-card-actions">{actions}</div> : null}
        </header>
      )}
      {children}
    </section>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? (
    <p className="bb-admin-error" role="alert">
      {error}
    </p>
  ) : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function timeAgo(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms == null) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString();
}

export function Cover({ src, title, size = 64 }: { src: string | null; title: string; size?: number }) {
  return src ? (
    <img className="bb-admin-cover" src={src} alt="" width={size} height={Math.round(size * 1.5)} loading="lazy" />
  ) : (
    <span className="bb-admin-cover is-blank" style={{ width: size, height: Math.round(size * 1.5) }} aria-hidden>
      {title.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Bar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="bb-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}
