import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BarnabyEmpty } from "../brand/Barnaby";
import { Card, ErrorNote, timeAgo, useAction, useLoad } from "../admin/ui";
import { CHECK_LABELS, HEALTH_CHECKS, librarianApi, type FileProblem } from "./api";

const PROBLEM_LABEL: Record<FileProblem["problem"], string> = {
  missing: "Missing on disk",
  unreadable: "Can't be opened",
  drm: "DRM-protected",
};

/** What needs a librarian: books missing details, and files that are gone or broken. */
export function HealthPage() {
  const health = useLoad(() => librarianApi.health());
  const check = useAction();
  const running = health.data?.running;

  // Poll while a file check runs.
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(health.reload, 2000);
    return () => clearTimeout(t);
  }, [running, health.data, health.reload]);

  const counts = health.data?.counts;
  const problems = health.data?.files?.problems ?? [];
  const allGood = counts && HEALTH_CHECKS.every((c) => counts[c] === 0) && health.data?.files && problems.length === 0;

  return (
    <>
      <h1 className="bb-h1">Library health</h1>
      <p className="bb-muted bb-admin-lede">
        Books that are missing a cover, a rating or an author, and files that are gone, damaged or locked with DRM. Fix them
        here, in bulk from <Link to="/admin/librarian/books">Edit books</Link>, or with a rescan.
      </p>
      <ErrorNote error={health.error} />
      {counts && (
        <div className="bb-tiles">
          {HEALTH_CHECKS.map((c) => (
            <Link key={c} className={`bb-tile${counts[c] ? " is-warn" : ""}`} to={`/admin/librarian/books?check=${c}`}>
              <span className="bb-tile-value">{counts[c]}</span>
              <span className="bb-tile-label">{CHECK_LABELS[c].title}</span>
              <span className="bb-tile-hint">{CHECK_LABELS[c].hint}</span>
            </Link>
          ))}
        </div>
      )}

      <Card
        title="Book files"
        actions={
          <button className="bb-btn bb-btn-small" disabled={check.busy || !!running} onClick={() => check.run(async () => (await librarianApi.checkFiles(), health.reload()))}>
            {running ? `Checking… ${Math.round((running.progress ?? 0) * 100)}%` : "Check every file"}
          </button>
        }
      >
        <ErrorNote error={check.error} />
        {health.data && !health.data.files ? (
          <p className="bb-muted">Files haven't been checked yet. A check opens every file to find ones that are missing, damaged or DRM-protected; it runs in the background.</p>
        ) : health.data?.files ? (
          <>
            <p className="bb-muted bb-small">
              Checked {health.data.files.filesChecked} files {timeAgo(health.data.files.checkedAt)}.
            </p>
            {problems.length === 0 ? (
              <p className="bb-ok">Every file opens fine.</p>
            ) : (
              <ul className="bb-lib-problems">
                {problems.map((p) => (
                  <li key={p.fileId} className={`is-${p.problem}`}>
                    <span className={`bb-lib-badge is-${p.problem}`}>{PROBLEM_LABEL[p.problem]}</span>
                    <div>
                      <strong>{p.title}</strong>
                      <div className="bb-muted bb-small">
                        <code>{p.relPath}</code>
                        {p.detail ? ` · ${p.detail}` : ""}
                      </div>
                    </div>
                    <span className="bb-muted bb-small">{FIX[p.problem]}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </Card>
      {allGood && (
        <BarnabyEmpty title="All tidy!" size={120}>
          Every book has a cover, a rating and an author, and every file opens.
        </BarnabyEmpty>
      )}
    </>
  );
}

const FIX: Record<FileProblem["problem"], string> = {
  missing: "Moved or deleted outside Bookbandit. A rescan finds moves.",
  unreadable: "Replace the file, or set it aside from Duplicates.",
  drm: "Bookbandit never removes DRM. Read it in the Kindle app.",
};

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
