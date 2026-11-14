import { useEffect, useRef } from "react";
import { adminApi, type ScanStatus } from "./api";
import { BackupCard } from "../ops/BackupCard";
import { Bar, Card, ErrorNote, Tile, timeAgo, useAction, useLoad } from "./ui";

export function AdminHome() {
  const overview = useLoad(() => adminApi.overview());
  const o = overview.data;
  return (
    <>
      <h1 className="bb-h1">Library admin</h1>
      <ErrorNote error={overview.error} />
      <div className="bb-tiles">
        <Tile label="Waiting in the inbox" value={o?.inbox ?? "…"} to="/admin/inbox" tone={o?.inbox ? "warn" : undefined} hint="New books stay hidden until approved" />
        <Tile label="Need a rating" value={o?.unrated ?? "…"} to="/admin/review" tone={o?.unrated ? "warn" : undefined} hint="Unrated books are treated as adult" />
        <Tile label="Books in the library" value={o?.books ?? "…"} />
        <Tile label="People" value={o ? o.people.grownUps + o.people.kids : "…"} hint={o ? `${o.people.grownUps} grown-ups, ${o.people.kids} kids` : null} to="/admin/people" />
        <Tile label="Paired devices" value={o?.devices ?? "…"} to="/admin/people#devices" />
        <Tile label="Book requests" value={o?.pendingRequests ?? "…"} hint="Pending a parent's OK" to="/requests?tab=approve" />
      </div>
      <ScanCard onFinished={overview.reload} />
      <BackupCard />
    </>
  );
}

export function ScanCard({ onFinished }: { onFinished?: () => void }) {
  const status = useLoad(() => adminApi.scanStatus());
  const action = useAction();
  const s = status.data;

  // Poll while a scan runs.
  useEffect(() => {
    if (!s?.running) return;
    const t = setTimeout(() => status.reload(), 1500);
    return () => clearTimeout(t);
  }, [s, status]);
  const wasRunning = useWasRunning(s);
  useEffect(() => {
    if (wasRunning && s && !s.running) onFinished?.();
  }, [wasRunning, s, onFinished]);

  const scan = () =>
    action.run(async () => {
      status.setData(await adminApi.startScan());
    });

  const r = s?.lastReport;
  return (
    <Card
      title="Library scan"
      actions={
        <button className="bb-btn bb-btn-primary" onClick={scan} disabled={action.busy || s?.running}>
          {s?.running ? "Scanning…" : "Scan now"}
        </button>
      }
    >
      <ErrorNote error={status.error ?? action.error} />
      {!s ? (
        <p className="bb-muted">Loading…</p>
      ) : s.running ? (
        <div className="bb-scan-running">
          <Bar value={s.progress && s.progress.total ? s.progress.done / s.progress.total : 0} />
          <p className="bb-muted bb-small">
            {s.progress ? `${s.progress.done.toLocaleString()} of ${s.progress.total.toLocaleString()} files` : "Starting…"} · started {timeAgo(s.startedAt)}
          </p>
        </div>
      ) : r ? (
        <>
          <p className="bb-muted bb-small">
            Last scan finished {timeAgo(r.finishedAt)} and took {Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000))} s.
          </p>
          <dl className="bb-scan-stats">
            <Stat label="Files seen" value={r.filesSeen} />
            <Stat label="New books" value={r.added} />
            <Stat label="New formats" value={r.attached} />
            <Stat label="Changed" value={r.updated} />
            <Stat label="Moved" value={r.moved} />
            <Stat label="Removed" value={r.removed} />
          </dl>
          {r.duplicates.length > 0 && (
            <details className="bb-scan-details">
              <summary>{r.duplicates.length} exact copies</summary>
              <ul>
                {r.duplicates.map((d) => (
                  <li key={d.relPath}>
                    <code>{d.relPath}</code> is the same file as <code>{d.sameAs}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {r.errors.length > 0 && (
            <details className="bb-scan-details is-warn" open={r.errors.length <= 3}>
              <summary>{r.errors.length} files had problems</summary>
              <ul>
                {r.errors.map((e) => (
                  <li key={e.relPath + e.error}>
                    <code>{e.relPath}</code>: {e.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <p className="bb-muted">No scan has run since the server started. Scan now to pick up books in your /books folder.</p>
      )}
      {s?.lastError && <p className="bb-admin-error">The last scan failed: {s.lastError}</p>}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value.toLocaleString()}</dd>
    </div>
  );
}

/** Whether the previous render saw a running scan. */
function useWasRunning(s: ScanStatus | null): boolean {
  const ref = useRef(false);
  const prev = ref.current;
  ref.current = s?.running ?? false;
  return prev;
}
