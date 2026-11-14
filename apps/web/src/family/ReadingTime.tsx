import { adminApi, type ReadingStats } from "../admin/api";
import { Card, Cover, ErrorNote, useLoad } from "../admin/ui";

/** "1 h 5 min", "12 min", "0 min" */
export function formatMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });

/** Last 7 days of reading and listening time for one kid, from the reading-time API. */
export function ReadingTimeCard({ kidId, kidName }: { kidId: string; kidName: string }) {
  const stats = useLoad(() => adminApi.readingStats(kidId, 7), [kidId]);
  const s = stats.data;
  return (
    <Card title="Reading time this week" className="bb-reading-time">
      <ErrorNote error={stats.error} />
      {!s ? (
        stats.error ? null : <p className="bb-muted">Loading…</p>
      ) : (
        <>
          <div className="bb-rt-summary">
            <div>
              <strong>{formatMinutes(s.totalSeconds)}</strong>
              <span className="bb-muted bb-small">in 7 days</span>
            </div>
            <div>
              <strong>{formatMinutes(s.totalSeconds / 7)}</strong>
              <span className="bb-muted bb-small">a day on average</span>
            </div>
            <div>
              <strong>
                {s.streakDays} day{s.streakDays === 1 ? "" : "s"}
                {s.streakDays >= 3 ? " 🔥" : ""}
              </strong>
              <span className="bb-muted bb-small">reading streak</span>
            </div>
          </div>
          <DayBars days={s.days} />
          <p className="bb-muted bb-small bb-rt-legend">
            <span className="bb-rt-swatch is-read" /> reading <span className="bb-rt-swatch is-listen" /> listening. Only time with the
            book open and {kidName} active counts.
          </p>
          {s.books.length > 0 && (
            <>
              <h3 className="bb-subhead">Most time spent on</h3>
              <ul className="bb-rt-books">
                {s.books.slice(0, 5).map((b) => (
                  <li key={b.id}>
                    <Cover src={adminApi.coverUrl(b)} title={b.title} size={32} />
                    <span className="bb-person-main">{b.title}</span>
                    <span className="bb-muted">{formatMinutes(b.seconds)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}

function DayBars({ days }: { days: ReadingStats["days"] }) {
  const max = Math.max(15 * 60, ...days.map((d) => d.readSeconds + d.listenSeconds));
  return (
    <ol className="bb-rt-bars" aria-label="Minutes per day">
      {days.map((d) => {
        const total = d.readSeconds + d.listenSeconds;
        return (
          <li key={d.date} aria-label={`${weekday(d.date)}: ${formatMinutes(total)}`}>
            <span className="bb-rt-value">{total ? Math.round(total / 60) : ""}</span>
            <span className="bb-rt-col">
              <span className="bb-rt-bar is-listen" style={{ height: `${(d.listenSeconds / max) * 100}%` }} />
              <span className="bb-rt-bar is-read" style={{ height: `${(d.readSeconds / max) * 100}%` }} />
            </span>
            <span className="bb-rt-day">{weekday(d.date)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Small "minutes this week" figure for a kid card on the dashboard. */
export function WeekMinutes({ kidId }: { kidId: string }) {
  const stats = useLoad(() => adminApi.readingStats(kidId, 7), [kidId]);
  if (!stats.data) return <dd>{stats.error ? "–" : "…"}</dd>;
  return (
    <dd>
      {formatMinutes(stats.data.totalSeconds)}
      {stats.data.streakDays >= 3 ? <small> · {stats.data.streakDays}-day streak</small> : null}
    </dd>
  );
}
