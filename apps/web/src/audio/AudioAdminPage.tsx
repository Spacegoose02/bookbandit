import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Card, ErrorNote, RatingPill, timeAgo, useAction, useLoad } from "../admin/ui";
import type { ContentRating } from "@bookbandit/shared";
import { audioAdminApi, type AbsAccountRow, type AbsImportResult } from "./adminApi";
import { formatTime } from "./timeline";
import "./audio.css";

/**
 * /admin/audio: the audiobook folder (scan and what's in it), each person's Audiobookshelf
 * account for write-back, and importing positions and bookmarks from Audiobookshelf.
 */
export function AudioAdminPage() {
  return (
    <>
      <h1 className="bb-h1">Audiobooks</h1>
      <p className="bb-muted bb-admin-lede">
        Audiobooks in your audiobook folder play right here, no Audiobookshelf needed. While the family still uses
        Audiobookshelf apps, link each person's account so listening positions stay in step both ways.
      </p>
      <div className="bb-settings-grid">
        <ScanCard />
        <AccountsCard />
      </div>
      <ImportCard />
      <LocalList />
    </>
  );
}

function ScanCard() {
  const status = useLoad(() => audioAdminApi.scanStatus());
  const action = useAction();
  const s = status.data;

  // Poll while a scan runs.
  useEffect(() => {
    if (!s?.running) return;
    const t = setInterval(status.reload, 1000);
    return () => clearInterval(t);
  }, [s?.running, status.reload]);

  const r = s?.lastReport;
  return (
    <Card title="Audiobook folder" actions={s ? <span className={`bb-status${s.running ? " is-on" : ""}`}>{s.running ? "Scanning…" : "Idle"}</span> : null}>
      <p className="bb-muted bb-small">
        One folder per book, like <code>Author/Title/</code> or <code>Author/Series/Title/</code>. MP3, M4B, M4A, OGG and FLAC.
        New audiobooks wait in the <Link to="/admin/inbox">inbox</Link> like new ebooks, and join the ebook of the same book when
        the ISBN or title and author match.
      </p>
      {s && (
        <dl className="bb-audio-facts">
          <dt>Folder</dt>
          <dd>
            <code>{s.audiobooksDir}</code>
          </dd>
          {s.running && s.progress && (
            <>
              <dt>Progress</dt>
              <dd>
                {s.progress.done} of {s.progress.total || "…"} folders
              </dd>
            </>
          )}
          {r && (
            <>
              <dt>Last scan</dt>
              <dd>
                {timeAgo(r.finishedAt)}: {r.foldersSeen} audiobooks, {r.added} new, {r.linked} joined an ebook
                {r.moved ? `, ${r.moved} moved` : ""}
                {r.removed ? `, ${r.removed} gone` : ""}
              </dd>
            </>
          )}
        </dl>
      )}
      {r && r.errors.length > 0 && (
        <details className="bb-small">
          <summary>{r.errors.length} files couldn't be read</summary>
          <ul>
            {r.errors.slice(0, 20).map((e, i) => (
              <li key={i}>
                <code>{e.relPath}</code>: {e.error}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ErrorNote error={status.error ?? action.error ?? s?.lastError ?? null} />
      <div className="bb-form-actions">
        <button
          className="bb-btn bb-btn-primary"
          disabled={action.busy || s?.running}
          onClick={() => void action.run(async () => status.setData(await audioAdminApi.startScan()))}
        >
          Scan now
        </button>
      </div>
    </Card>
  );
}

function AccountsCard() {
  const rows = useLoad(() => audioAdminApi.accounts());
  return (
    <Card title="Audiobookshelf accounts">
      <p className="bb-muted bb-small">
        For each person, make an API key in Audiobookshelf (Settings → API Keys, acting as their user) and paste it here.
        Their positions are then written back to Audiobookshelf, newest wins.
      </p>
      <ErrorNote error={rows.error} />
      <ul className="bb-abs-accounts">
        {rows.data?.map((r) => (
          <AccountRow key={r.userId} row={r} onChange={rows.reload} />
        ))}
      </ul>
    </Card>
  );
}

function AccountRow({ row, onChange }: { row: AbsAccountRow; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const action = useAction();
  const a = row.account;

  const save = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await audioAdminApi.saveAccount(row.userId, { token: token.trim() });
      setToken("");
      setOpen(false);
      onChange();
    });
  };

  return (
    <li>
      <div className="bb-abs-account-head">
        <div className="bb-abs-account-main">
          <strong>{row.displayName}</strong>
          <div className="bb-muted bb-small">
            {a ? (
              <>
                Audiobookshelf user <strong>{a.absUsername}</strong>
                {a.lastPushAt ? ` · last synced ${timeAgo(a.lastPushAt)}` : ""}
              </>
            ) : (
              "Not linked"
            )}
          </div>
          {a?.lastError && <div className="bb-error bb-small">{a.lastError}</div>}
        </div>
        {a && (
          <label className="bb-field-inline bb-small">
            <input
              type="checkbox"
              checked={a.writeBack}
              disabled={action.busy}
              onChange={(e) =>
                void action.run(async () => {
                  await audioAdminApi.saveAccount(row.userId, { writeBack: e.target.checked });
                  onChange();
                })
              }
            />
            Write back
          </label>
        )}
        <button className="bb-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {a ? "Change" : "Link"}
        </button>
      </div>
      {open && (
        <form className="bb-abs-account-form" onSubmit={save}>
          <input
            className="bb-input"
            type="password"
            autoComplete="off"
            placeholder={`${row.displayName}'s Audiobookshelf API key`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            aria-label={`${row.displayName}'s Audiobookshelf API key`}
          />
          <button className="bb-btn bb-btn-primary" disabled={action.busy}>
            Save
          </button>
          {a && (
            <button
              type="button"
              className="bb-btn bb-btn-ghost"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await audioAdminApi.unlinkAccount(row.userId);
                  setOpen(false);
                  onChange();
                })
              }
            >
              Unlink
            </button>
          )}
        </form>
      )}
      <ErrorNote error={action.error} />
    </li>
  );
}

function ImportCard() {
  const [result, setResult] = useState<AbsImportResult | null>(null);
  const action = useAction();
  const accounts = useLoad(() => audioAdminApi.accounts());
  const names = new Map(accounts.data?.map((a) => [a.userId, a.displayName]) ?? []);
  const linked = accounts.data?.filter((a) => a.account).length ?? 0;

  const run = (dryRun: boolean) => void action.run(async () => setResult(await audioAdminApi.importAbs({ dryRun })));

  return (
    <Card title="Import from Audiobookshelf">
      <p className="bb-muted bb-small">
        Brings in each linked person's listening positions, finished books and bookmarks for audiobooks that are linked to a book
        here. A position that is newer in Bookbandit is kept. Preview first; nothing changes until you import.
      </p>
      <div className="bb-form-actions">
        <button className="bb-btn" disabled={action.busy || !linked} onClick={() => run(true)}>
          Preview
        </button>
        <button className="bb-btn bb-btn-primary" disabled={action.busy || !linked} onClick={() => run(false)}>
          Import
        </button>
        {!linked && accounts.data && <span className="bb-muted bb-small">Link someone's account first.</span>}
      </div>
      <ErrorNote error={action.error} />
      {result && (
        <div className="bb-abs-import">
          <p className={result.dryRun ? "bb-muted" : "bb-ok"}>{result.dryRun ? "Preview: nothing has been changed yet." : "Imported."}</p>
          <table className="bb-abs-import-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Positions</th>
                <th>Finished</th>
                <th>Newer here</th>
                <th>Bookmarks</th>
                <th>Not linked</th>
              </tr>
            </thead>
            <tbody>
              {result.reports.map((r) => (
                <tr key={r.userId}>
                  <td>
                    {names.get(r.userId) ?? r.absUsername} <span className="bb-muted bb-small">({r.absUsername})</span>
                  </td>
                  <td>{r.imported}</td>
                  <td>{r.finished}</td>
                  <td>{r.keptNewer}</td>
                  <td>{r.bookmarksImported}</td>
                  <td>{r.unlinked}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.reports.some((r) => r.unlinked) && (
            <p className="bb-muted bb-small">
              "Not linked" audiobooks aren't matched to a book here yet. Run auto-link under <Link to="/admin/settings">Connections</Link>{" "}
              and import again.
            </p>
          )}
          {result.errors.map((e) => (
            <p key={e.userId} className="bb-error">
              {names.get(e.userId) ?? e.userId}: {e.error}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

function LocalList() {
  const [q, setQ] = useState("");
  const list = useLoad(() => audioAdminApi.audiobooks(q.trim() || undefined), [q]);
  return (
    <Card title="In the audiobook folder" actions={<input className="bb-input" type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search audiobooks" />}>
      <ErrorNote error={list.error} />
      {list.data && list.data.length === 0 && <p className="bb-muted">No audiobooks found yet. Put a folder in, then scan.</p>}
      <ul className="bb-audio-list">
        {list.data?.map((a) => (
          <li key={a.id}>
            <div className="bb-audio-list-main">
              <Link to={a.approved ? `/book/${a.bookId}` : "/admin/inbox"}>{a.title}</Link>
              <div className="bb-muted bb-small">
                <code>{a.relPath}</code>
              </div>
              <div className="bb-muted bb-small">
                {formatTime(a.duration)} · {a.trackCount} {a.trackCount === 1 ? "file" : "files"} · {a.chapterCount} chapters
                {a.narrator ? ` · read by ${a.narrator}` : ""}
                {a.absItemId ? " · also in Audiobookshelf" : ""}
              </div>
            </div>
            <div className="bb-audio-list-tags">
              {!a.approved && <span className="bb-tag">In the inbox</span>}
              <RatingPill rating={a.rating as ContentRating | null} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
