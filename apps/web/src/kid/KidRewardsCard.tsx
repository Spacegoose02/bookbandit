import { useEffect, useState } from "react";
import { DEFAULT_BEDTIME, formatMinute, type BedtimeSettings, type ReadingGoal } from "@bookbandit/shared";
import { Card, ErrorNote, useAction, useLoad } from "../admin/ui";
import { formatMinutes } from "../family/ReadingTime";
import { browserTimeZone, rewardsApi } from "./api";
import { wakeTime } from "./Bedtime";
import { BadgeShelf, GoalRing } from "./Rewards";
import "./kid.css";

const MINUTE_CHOICES = [10, 15, 20, 30, 45, 60];
const BOOK_CHOICES = [1, 2, 3, 4, 6, 8, 10];

const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromTime = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Parent card on /family/kids/:id: the kid's goal progress and badges, and (for a linked parent
 * or admin) the goal and reading bedtime settings. The server checks who may change them.
 */
export function KidRewardsCard({ kidId, kidName }: { kidId: string; kidName: string }) {
  const summary = useLoad(() => rewardsApi.summary(kidId), [kidId]);
  const settings = useLoad(() => rewardsApi.settings(kidId), [kidId]);
  const s = summary.data;
  const earned = s?.badges.filter((b) => b.earnedAt) ?? [];

  return (
    <Card title="Goals, badges and bedtime" className="bb-kid-rewards-card">
      <ErrorNote error={summary.error ?? settings.error} />
      {s && (
        <div className="bb-kid-rewards-summary">
          {s.today.goalSeconds != null ? (
            <GoalRing
              value={s.today.readSeconds}
              goal={s.today.goalSeconds}
              size={84}
              label={`${formatMinutes(s.today.readSeconds)} of ${formatMinutes(s.today.goalSeconds)} today`}
            >
              <span className="bb-goal-ring-small">{s.today.met ? "🎯 done" : `${Math.floor(s.today.readSeconds / 60)}/${s.today.goalSeconds / 60}`}</span>
            </GoalRing>
          ) : null}
          <div>
            <p>
              <strong>{formatMinutes(s.today.readSeconds)}</strong> today
              {s.today.goalSeconds != null ? ` of a ${formatMinutes(s.today.goalSeconds)} goal` : ""} · {s.streakDays}-day streak
            </p>
            <p className="bb-muted bb-small">
              {s.month.goalBooks != null
                ? `${s.month.books} of ${s.month.goalBooks} books finished this month`
                : `${s.booksFinished} book${s.booksFinished === 1 ? "" : "s"} finished in all`}
              {` · ${earned.length} of ${s.badges.length} badges · ${s.stickers.length} stickers`}
            </p>
          </div>
        </div>
      )}
      {earned.length > 0 && <BadgeShelf badges={earned} compact />}
      {settings.data &&
        (settings.data.canEdit ? (
          <>
            <GoalForm kidId={kidId} kidName={kidName} goal={settings.data.goal} onSaved={summary.reload} />
            <BedtimeForm kidId={kidId} kidName={kidName} bedtime={settings.data.bedtime} />
          </>
        ) : (
          <p className="bb-muted bb-small">Only {kidName}'s linked parents or an admin can change goals and bedtime.</p>
        ))}
    </Card>
  );
}

function GoalForm({ kidId, kidName, goal, onSaved }: { kidId: string; kidName: string; goal: ReadingGoal | null; onSaved: () => void }) {
  const [minutes, setMinutes] = useState<number | null>(goal?.minutesPerDay ?? null);
  const [books, setBooks] = useState<number | null>(goal?.booksPerMonth ?? null);
  const [saved, setSaved] = useState(false);
  const act = useAction();
  const dirty = minutes !== (goal?.minutesPerDay ?? null) || books !== (goal?.booksPerMonth ?? null);
  useEffect(() => setSaved(false), [minutes, books]);

  const save = async () => {
    const r = await act.run(() => rewardsApi.saveGoal(kidId, { minutesPerDay: minutes, booksPerMonth: books, timeZone: browserTimeZone() }));
    if (r !== undefined) {
      setSaved(true);
      onSaved();
    }
  };

  return (
    <form
      className="bb-kid-rewards-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="bb-subhead">Reading goal</h3>
      <p className="bb-muted bb-small">{kidName} earns a sticker each day the goal is reached, and badges for streaks.</p>
      <div className="bb-kid-rewards-fields">
        <label className="bb-field">
          <span>Minutes a day</span>
          <select className="bb-input" value={minutes ?? ""} onChange={(e) => setMinutes(e.target.value ? Number(e.target.value) : null)}>
            <option value="">No daily goal</option>
            {[...new Set([...MINUTE_CHOICES, ...(minutes ? [minutes] : [])])]
              .sort((a, b) => a - b)
              .map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
          </select>
        </label>
        <label className="bb-field">
          <span>Books a month</span>
          <select className="bb-input" value={books ?? ""} onChange={(e) => setBooks(e.target.value ? Number(e.target.value) : null)}>
            <option value="">No monthly goal</option>
            {[...new Set([...BOOK_CHOICES, ...(books ? [books] : [])])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  {n} book{n === 1 ? "" : "s"}
                </option>
              ))}
          </select>
        </label>
      </div>
      <ErrorNote error={act.error} />
      <button className="bb-btn bb-btn-primary" disabled={act.busy || !dirty}>
        Save goal
      </button>
      {saved && <span className="bb-muted bb-small"> Saved.</span>}
    </form>
  );
}

function BedtimeForm({ kidId, kidName, bedtime }: { kidId: string; kidName: string; bedtime: BedtimeSettings }) {
  const [b, setB] = useState<BedtimeSettings>(bedtime.enabled ? bedtime : { ...DEFAULT_BEDTIME, ...bedtime });
  const [weekend, setWeekend] = useState(bedtime.weekendStartMinute != null);
  const [msg, setMsg] = useState<string | null>(null);
  const act = useAction();
  const set = (patch: Partial<BedtimeSettings>) => {
    setMsg(null);
    setB((x) => ({ ...x, ...patch }));
  };

  const save = async () => {
    const body: BedtimeSettings = {
      ...b,
      weekendStartMinute: weekend ? (b.weekendStartMinute ?? Math.min(b.startMinute + 60, 1439)) : null,
      timeZone: browserTimeZone(),
    };
    const r = await act.run(() => rewardsApi.saveBedtime(kidId, body));
    if (!r) return;
    setB(r.bedtime);
    setMsg(
      !r.bedtime.enabled
        ? "Bedtime is off."
        : r.bedtimeNow.active && r.bedtimeNow.endsAt
          ? `Saved. It's bedtime now; books open again at ${wakeTime(r.bedtimeNow.endsAt)}.`
          : "Saved.",
    );
  };

  return (
    <form
      className="bb-kid-rewards-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="bb-subhead">Reading bedtime</h3>
      <p className="bb-muted bb-small">
        From bedtime until morning, {kidName}'s books won't open on any device or browser (the server enforces it). Bedtime stories in
        storyteller mode keep their own limits. Books already downloaded to a tablet for offline reading can still open.
      </p>
      <label className="bb-field bb-field-inline">
        <input type="checkbox" checked={b.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>Turn on reading bedtime</span>
      </label>
      {b.enabled && (
        <div className="bb-kid-rewards-fields">
          <label className="bb-field">
            <span>Bedtime (school nights)</span>
            <input className="bb-input" type="time" min="12:00" max="23:59" value={toTime(b.startMinute)} onChange={(e) => set({ startMinute: fromTime(e.target.value) })} />
          </label>
          <label className="bb-field">
            <span>Books wake up at</span>
            <input className="bb-input" type="time" min="00:00" max="12:00" value={toTime(b.endMinute)} onChange={(e) => set({ endMinute: fromTime(e.target.value) })} />
          </label>
          <label className="bb-field bb-field-inline">
            <input type="checkbox" checked={weekend} onChange={(e) => setWeekend(e.target.checked)} />
            <span>Later on Friday and Saturday</span>
          </label>
          {weekend && (
            <label className="bb-field">
              <span>Weekend bedtime</span>
              <input
                className="bb-input"
                type="time"
                min="12:00"
                max="23:59"
                value={toTime(b.weekendStartMinute ?? Math.min(b.startMinute + 60, 1439))}
                onChange={(e) => set({ weekendStartMinute: fromTime(e.target.value) })}
              />
            </label>
          )}
        </div>
      )}
      {b.enabled && (
        <p className="bb-muted bb-small">
          {kidName} reads until {formatMinute(b.startMinute)}
          {weekend ? ` (${formatMinute(b.weekendStartMinute ?? Math.min(b.startMinute + 60, 1439))} on weekends)` : ""}; books open again at{" "}
          {formatMinute(b.endMinute)}.
        </p>
      )}
      <ErrorNote error={act.error} />
      <button className="bb-btn bb-btn-primary" disabled={act.busy}>
        Save bedtime
      </button>
      {msg && <span className="bb-muted bb-small"> {msg}</span>}
    </form>
  );
}
