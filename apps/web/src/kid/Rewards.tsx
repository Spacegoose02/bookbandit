import { useState } from "react";
import { Link } from "react-router-dom";
import { STICKER_REASON_LABELS, type NewAward, type RewardBadge, type RewardsSummary, type RewardSticker } from "@bookbandit/shared";
import { BarnabySays } from "../brand/Barnaby";
import { useLoad } from "../admin/ui";
import { rewardsApi } from "./api";
import "./kid.css";

/** "14 of 20 minutes" as a ring a 7 year old can read at a glance. */
export function GoalRing({
  value,
  goal,
  size = 132,
  label,
  children,
}: {
  value: number;
  goal: number;
  size?: number;
  label: string;
  children?: React.ReactNode;
}) {
  const stroke = Math.max(10, size / 9);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = goal > 0 ? Math.min(1, value / goal) : 0;
  const done = goal > 0 && value >= goal;
  return (
    <div className={`bb-goal-ring${done ? " is-done" : ""}`} role="img" aria-label={label} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="bb-goal-ring-track" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="bb-goal-ring-fill"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="bb-goal-ring-inner" aria-hidden>
        {children}
      </div>
    </div>
  );
}

/** Today's goal, the month's books and the streak: the top of the kid home. */
export function GoalPanel({ s }: { s: RewardsSummary }) {
  const minutes = Math.floor(s.today.readSeconds / 60);
  const goalMin = s.today.goalSeconds != null ? Math.round(s.today.goalSeconds / 60) : null;
  return (
    <div className="bb-goal-panel">
      {goalMin != null ? (
        <GoalRing value={minutes} goal={goalMin} label={`${minutes} of ${goalMin} minutes read today`}>
          {s.today.met ? (
            <span className="bb-goal-ring-big">🎯</span>
          ) : (
            <>
              <span className="bb-goal-ring-big">{minutes}</span>
              <span className="bb-goal-ring-small">of {goalMin} min</span>
            </>
          )}
        </GoalRing>
      ) : (
        <GoalRing value={0} goal={0} label={`${minutes} minutes read today`}>
          <span className="bb-goal-ring-big">{minutes}</span>
          <span className="bb-goal-ring-small">min today</span>
        </GoalRing>
      )}
      <div className="bb-goal-facts">
        <p className="bb-goal-fact">
          <span aria-hidden className="bb-goal-fact-icon">
            🔥
          </span>
          <span>
            <strong>{s.streakDays}</strong> day{s.streakDays === 1 ? "" : "s"} in a row
          </span>
        </p>
        {s.month.goalBooks != null ? (
          <p className="bb-goal-fact" aria-label={`${s.month.books} of ${s.month.goalBooks} books this month`}>
            <span aria-hidden className="bb-goal-fact-icon">
              📚
            </span>
            <span className="bb-goal-dots" aria-hidden>
              {Array.from({ length: s.month.goalBooks }, (_, i) => (
                <i key={i} className={i < s.month.books ? "is-on" : ""} />
              ))}
            </span>
            <span>
              <strong>{Math.min(s.month.books, s.month.goalBooks)}</strong> of {s.month.goalBooks} books this month
            </span>
          </p>
        ) : (
          <p className="bb-goal-fact">
            <span aria-hidden className="bb-goal-fact-icon">
              📚
            </span>
            <span>
              <strong>{s.booksFinished}</strong> book{s.booksFinished === 1 ? "" : "s"} finished
            </span>
          </p>
        )}
        {s.today.met && <p className="bb-goal-yay">You reached today's goal!</p>}
      </div>
    </div>
  );
}

/**
 * New badges and stickers, shown on the kid home (never inside the reader, so a celebration
 * never interrupts a page). Tapping "Yay!" tells the server they were seen.
 */
export function Celebration({ fresh, onDone }: { fresh: NewAward[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!fresh.length) return null;
  const badges = fresh.filter((a) => a.kind === "badge");
  const stickers = fresh.filter((a) => a.kind === "sticker");
  const first = badges[0] ?? stickers[0]!;
  const others = fresh.length - 1;
  const done = () => {
    setBusy(true);
    rewardsApi
      .markSeen(fresh.map((a) => a.id))
      .catch(() => undefined)
      .finally(onDone);
  };
  return (
    <section className="bb-celebrate" role="status" aria-live="polite">
      <div className="bb-celebrate-burst" aria-hidden>
        {["🎉", "⭐", "✨", "🎈", "⭐", "🎉"].map((e, i) => (
          <span key={i} style={{ ["--i" as string]: i }}>
            {e}
          </span>
        ))}
      </div>
      <span className="bb-celebrate-emoji" aria-hidden>
        {first.emoji}
      </span>
      <div className="bb-celebrate-text">
        <strong>{first.kind === "badge" ? `New badge: ${first.name}` : first.name}</strong>
        {others > 0 && (
          <span>
            {" "}
            and {others} more {stickers.length > 1 || badges.length > 1 ? "rewards" : "reward"}!
          </span>
        )}
        <span className="bb-celebrate-row" aria-hidden>
          {fresh.slice(1, 9).map((a) => (
            <span key={a.id}>{a.emoji}</span>
          ))}
        </span>
      </div>
      <button className="bb-btn bb-btn-primary bb-btn-big" onClick={done} disabled={busy}>
        Yay! 🎉
      </button>
    </section>
  );
}

export function BadgeShelf({ badges, compact = false }: { badges: RewardBadge[]; compact?: boolean }) {
  const list = compact ? badges.filter((b) => b.earnedAt) : badges;
  return (
    <ul className={`bb-badges${compact ? " is-compact" : ""}`}>
      {list.map((b) => (
        <li
          key={b.id}
          className={`bb-badge-item${b.earnedAt ? " is-earned" : ""}`}
          aria-label={b.earnedAt ? `${b.name}: earned` : `${b.name}: not yet. ${b.hint}`}
        >
          <span className="bb-badge-emoji" aria-hidden>
            {b.earnedAt ? b.emoji : "🔒"}
          </span>
          <span className="bb-badge-name">{b.name}</span>
          {!compact && !b.earnedAt && <span className="bb-badge-hint">{b.hint}</span>}
        </li>
      ))}
    </ul>
  );
}

const shortDate = (d: string) => new Date(`${d.length === 7 ? `${d}-15` : d}T12:00:00Z`).toLocaleDateString(undefined, d.length === 7 ? { month: "long", timeZone: "UTC" } : { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

function stickerLabel(s: RewardSticker): string {
  if (s.reason === "book") return s.book ? s.book.title : STICKER_REASON_LABELS.book;
  if (s.reason === "goal_day") return `Goal reached · ${shortDate(s.key)}`;
  return `Book goal · ${shortDate(s.key)}`;
}

/** The sticker book page: every badge (earned or still to earn) and every sticker. */
export function StickerBookPage() {
  const res = useLoad(() => rewardsApi.summary("me"), []);
  const s = res.data;
  return (
    <div className="bb-page bb-kid bb-stickerbook">
      <p>
        <Link to="/" className="bb-btn bb-btn-big">
          <span aria-hidden>⬅️</span> Back to my books
        </Link>
      </p>
      <BarnabySays size={72}>
        <span className="bb-kid-hello">
          {s ? `You have ${s.badges.filter((b) => b.earnedAt).length} badges and ${s.stickers.length} stickers!` : "Let's look at your stickers!"}
        </span>
      </BarnabySays>
      {res.error && <p className="bb-muted">Barnaby can't find your sticker book right now.</p>}
      {s && (
        <>
          <h2 className="bb-kid-h2">
            <span aria-hidden>🏅</span> My badges
          </h2>
          <BadgeShelf badges={s.badges} />
          <h2 className="bb-kid-h2">
            <span aria-hidden>🌟</span> My stickers
          </h2>
          {s.stickers.length === 0 ? (
            <p className="bb-kid-empty">Finish a book or reach your reading goal to get your first sticker!</p>
          ) : (
            <ul className="bb-stickers">
              {s.stickers.map((x) => (
                <li key={x.id} className="bb-sticker" style={{ ["--tilt" as string]: `${(x.id.charCodeAt(x.id.length - 1) % 7) - 3}deg` }}>
                  <span className="bb-sticker-emoji" aria-hidden>
                    {x.emoji}
                  </span>
                  <span className="bb-sticker-label">{stickerLabel(x)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
