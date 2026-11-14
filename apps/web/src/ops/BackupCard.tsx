/** "Backups" card on the admin overview: schedule, recent backups, Back up now. */
import { Card, ErrorNote, formatBytes, timeAgo, useAction, useLoad } from "../admin/ui";
import { backupApi } from "./api";
import "./ops.css";

const REASON: Record<string, string> = {
  scheduled: "Nightly",
  manual: "Manual",
  "before-restore": "Saved before a restore",
  unknown: "",
};

export function BackupCard() {
  const status = useLoad(() => backupApi.status());
  const action = useAction();
  const s = status.data;
  const backUp = () =>
    action.run(async () => {
      await backupApi.backUpNow();
      status.reload();
    });

  return (
    <Card
      title="Backups"
      className="bb-backup-card"
      actions={
        <button className="bb-btn bb-btn-primary" onClick={backUp} disabled={action.busy || s?.running}>
          {action.busy || s?.running ? "Backing up…" : "Back up now"}
        </button>
      }
    >
      <ErrorNote error={status.error ?? action.error} />
      {s?.lastError && <p className="bb-admin-error">The last backup failed {timeAgo(s.lastError.at)}: {s.lastError.message}</p>}
      {!s ? (
        <p className="bb-muted">Loading…</p>
      ) : (
        <>
          <p className="bb-muted bb-small">
            {s.schedule
              ? `Every night at ${s.schedule}, keeping the last ${s.keep || "all"}. `
              : "Nightly backups are off (BACKUP_TIME=off). "}
            Saved in <code>{s.dir}</code>. People, reading progress, bookmarks and ratings are in here; your book files stay in /books.
          </p>
          {s.backups.length === 0 ? (
            <p className="bb-muted">No backups yet.</p>
          ) : (
            <ul className="bb-backup-list">
              {s.backups.slice(0, 5).map((b) => (
                <li key={b.name}>
                  <span>
                    <strong>{new Date(b.createdAt).toLocaleString()}</strong>
                    <span className="bb-muted bb-small">
                      {" "}
                      · {formatBytes(b.sizeBytes)}
                      {REASON[b.reason] ? ` · ${REASON[b.reason]}` : ""}
                    </span>
                  </span>
                  <a className="bb-btn bb-btn-small" href={backupApi.downloadUrl(b.name)} download>
                    Download
                  </a>
                </li>
              ))}
            </ul>
          )}
          <details className="bb-scan-details">
            <summary>How to restore</summary>
            <p className="bb-small">
              Stop the container, then run <code>docker run --rm -v &lt;your appdata&gt;:/config ghcr.io/spacegoose02/bookbandit restore latest</code>{" "}
              (or a backup's name instead of <code>latest</code>) and start it again. The database that was there is kept as a backup first.
            </p>
          </details>
        </>
      )}
    </Card>
  );
}
