import { useState } from "react";
import { BarnabyEmpty } from "../brand/Barnaby";
import { Card, Cover, ErrorNote, formatBytes, RatingPill, useAction, useLoad } from "../admin/ui";
import { librarianApi, REASON_LABELS, type CopyGroup, type WorkGroup } from "./api";

/** Library-wide duplicates: side by side, then merge formats, keep one, or "not duplicates". */
export function DuplicatesPage() {
  const dupes = useLoad(() => librarianApi.duplicates());
  const clear = useAction();
  const d = dupes.data;
  const empty = d && d.sameWork.length === 0 && d.copies.length === 0;

  return (
    <>
      <h1 className="bb-h1">
        Duplicates {d ? <span className="bb-count">{d.sameWork.length + d.copies.length}</span> : null}
      </h1>
      <p className="bb-muted bb-admin-lede">
        Books that look like the same work, and the same file saved twice. <b>Merge</b> keeps every format on one book.{" "}
        <b>Keep only this</b> moves the other copies' files to <code>.duplicates</code> in your books folder (nothing is
        deleted). Reading progress and bookmarks always move to the book you keep.
      </p>
      <ErrorNote error={dupes.error} />
      {empty && (
        <BarnabyEmpty title="No duplicates" size={130}>
          Every book in the library is one of a kind.
        </BarnabyEmpty>
      )}
      {d?.sameWork.map((g) => <WorkGroupCard key={g.key} group={g} onDone={dupes.reload} />)}
      {d && d.copies.length > 0 && (
        <>
          <h2 className="bb-h2 bb-lib-h2">Same file, more than once</h2>
          {d.copies.map((g) => (
            <CopyGroupCard key={g.sha256} group={g} onDone={dupes.reload} />
          ))}
        </>
      )}
      {d && d.ignored > 0 && (
        <p className="bb-muted bb-small">
          {d.ignored} group{d.ignored === 1 ? "" : "s"} marked "not duplicates".{" "}
          <button className="bb-linkbtn" disabled={clear.busy} onClick={() => clear.run(async () => (await librarianApi.clearIgnored(), dupes.reload()))}>
            Show them again
          </button>
        </p>
      )}
    </>
  );
}

function WorkGroupCard({ group, onDone }: { group: WorkGroup; onDone: () => void }) {
  const [keepId, setKeepId] = useState(group.books[0]!.id);
  const [confirm, setConfirm] = useState<"keep" | null>(null);
  const act = useAction();
  const others = group.books.filter((b) => b.id !== keepId).map((b) => b.id);
  const run = (fn: () => Promise<unknown>) => act.run(async () => (await fn(), onDone()));

  return (
    <Card
      className="bb-dupe-group"
      title={
        <>
          {group.books[0]!.title} <span className="bb-lib-reason">{REASON_LABELS[group.reason]}</span>
        </>
      }
    >
      <div className="bb-dupe-cols" role="radiogroup" aria-label="Book to keep">
        {group.books.map((b) => (
          <label key={b.id} className={`bb-dupe-col${b.id === keepId ? " is-keep" : ""}`}>
            <span className="bb-dupe-pick">
              <input type="radio" name={`keep-${group.key}`} checked={b.id === keepId} onChange={() => setKeepId(b.id)} />
              {b.id === keepId ? "Keep this one" : "Keep this one instead"}
            </span>
            <div className="bb-dupe-book">
              <Cover src={librarianApi.coverUrl(b)} title={b.title} size={64} />
              <div>
                <strong>{b.title}</strong>
                <div className="bb-muted">{b.authors.join(", ") || "No author"}</div>
                <div className="bb-dupe-meta">
                  <RatingPill rating={b.rating} />
                  {!b.approved && <span className="bb-tag">In the inbox</span>}
                  {b.series && (
                    <span className="bb-tag">
                      {b.series.name}
                      {b.series.position != null ? ` #${b.series.position}` : ""}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <dl className="bb-dupe-facts">
              <dt>ISBN</dt>
              <dd>{b.isbn13 ?? "—"}</dd>
              <dt>Year</dt>
              <dd>{b.publishedYear ?? "—"}</dd>
              <dt>Readers</dt>
              <dd>
                {b.readers} reading{b.bookmarks ? ` · ${b.bookmarks} bookmarks` : ""}
              </dd>
            </dl>
            <ul className="bb-dupe-files">
              {b.files.length === 0 && <li className="bb-muted">No files</li>}
              {b.files.map((f) => (
                <li key={f.id}>
                  <b>{f.format.toUpperCase()}</b> {formatBytes(f.sizeBytes)} <code>{f.relPath}</code>
                </li>
              ))}
            </ul>
          </label>
        ))}
      </div>
      <ErrorNote error={act.error} />
      {confirm === "keep" ? (
        <div className="bb-confirm">
          <span>
            Move {group.books.filter((b) => b.id !== keepId).reduce((n, b) => n + b.files.length, 0)} file(s) to <code>.duplicates</code> and remove the other
            record{others.length === 1 ? "" : "s"}?
          </span>
          <button className="bb-btn bb-btn-small bb-btn-danger" disabled={act.busy} onClick={() => run(() => librarianApi.keepDuplicate(keepId, others))}>
            Yes, keep only this
          </button>
          <button className="bb-btn bb-btn-small bb-btn-ghost" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="bb-dupe-actions">
          <button className="bb-btn bb-btn-primary bb-btn-small" disabled={act.busy} onClick={() => run(() => librarianApi.mergeDuplicates(keepId, others))}>
            Merge formats into one book
          </button>
          <button className="bb-btn bb-btn-small" disabled={act.busy} onClick={() => setConfirm("keep")}>
            Keep only this
          </button>
          <button className="bb-btn bb-btn-small bb-btn-ghost" disabled={act.busy} onClick={() => run(() => librarianApi.ignoreDuplicates(group.books.map((b) => b.id)))}>
            Not duplicates
          </button>
        </div>
      )}
    </Card>
  );
}

function CopyGroupCard({ group, onDone }: { group: CopyGroup; onDone: () => void }) {
  const [keep, setKeep] = useState(group.files[0]!.id);
  const act = useAction();
  const extra = group.files.filter((f) => f.id !== keep).map((f) => f.id);
  return (
    <Card className="bb-dupe-group" title={<>{group.files[0]!.bookTitle} <span className="bb-lib-reason">Identical files · {formatBytes(group.sizeBytes)}</span></>}>
      <ul className="bb-copy-list" role="radiogroup" aria-label="Copy to keep">
        {group.files.map((f) => (
          <li key={f.id}>
            <label>
              <input type="radio" name={`copy-${group.sha256}`} checked={f.id === keep} onChange={() => setKeep(f.id)} />
              <code>{f.relPath}</code>
              {f.id === keep ? <span className="bb-tag">keep</span> : <span className="bb-muted bb-small">set aside</span>}
            </label>
          </li>
        ))}
      </ul>
      <ErrorNote error={act.error} />
      <div className="bb-dupe-actions">
        <button className="bb-btn bb-btn-small bb-btn-primary" disabled={act.busy} onClick={() => act.run(async () => (await librarianApi.removeCopies(extra), onDone()))}>
          Set aside {extra.length} extra cop{extra.length === 1 ? "y" : "ies"}
        </button>
      </div>
    </Card>
  );
}
