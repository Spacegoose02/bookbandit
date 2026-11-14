import { useState } from "react";
import type { ContentRating } from "@bookbandit/shared";
import { BarnabyEmpty } from "../brand/Barnaby";
import { adminApi, type InboxItem } from "./api";
import { BookEditor } from "./BookEditor";
import { Card, Cover, ErrorNote, formatBytes, RatingButtons, RatingPill, SHORT_RATING, timeAgo, useAction, useLoad } from "./ui";

/** New books from the scanner wait here until an admin approves them. */
export function InboxPage() {
  const inbox = useLoad(() => adminApi.inbox());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulk = useAction();
  const items = inbox.data?.items ?? [];

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const remove = (id: string) => {
    inbox.setData((d) => (d ? { ...d, items: d.items.filter((b) => b.id !== id), total: d.total - 1 } : d));
    setSelected((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  };
  const replace = (b: InboxItem) => inbox.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === b.id ? b : x)) } : d));

  const approveSelected = (rating?: ContentRating) =>
    bulk.run(async () => {
      const ids = [...selected];
      await adminApi.approve(ids, rating);
      ids.forEach(remove);
    });

  const allSelected = items.length > 0 && items.every((b) => selected.has(b.id));
  const unratedSelected = items.some((b) => selected.has(b.id) && !b.rating);

  return (
    <>
      <h1 className="bb-h1">
        Inbox {inbox.data ? <span className="bb-count">{inbox.data.total}</span> : null}
      </h1>
      <p className="bb-muted bb-admin-lede">
        New books from your /books folder wait here, hidden from everyone else, until you approve them. Check the rating
        Barnaby guessed, fix the details if the file had none, and merge copies of books you already have.
      </p>
      <ErrorNote error={inbox.error} />
      {inbox.data && items.length === 0 ? (
        <BarnabyEmpty title="Inbox zero!" size={140}>
          New books show up here after a library scan.
        </BarnabyEmpty>
      ) : (
        <>
          <div className="bb-bulkbar" role="toolbar" aria-label="Selected books">
            <label className="bb-field bb-field-inline">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((b) => b.id)))}
              />
              {selected.size ? `${selected.size} selected` : "Select all"}
            </label>
            {selected.size > 0 && (
              <>
                <button className="bb-btn bb-btn-primary" disabled={bulk.busy} onClick={() => approveSelected()}>
                  Approve {selected.size}
                  {unratedSelected ? " (unrated stay adult-only)" : ""}
                </button>
                <span className="bb-muted bb-small">or approve as</span>
                <RatingButtons value={null} disabled={bulk.busy} onPick={(r) => approveSelected(r)} label="Approve selected with rating" />
              </>
            )}
          </div>
          <ErrorNote error={bulk.error} />
          <ul className="bb-inbox">
            {items.map((b) => (
              <InboxRow key={b.id} book={b} selected={selected.has(b.id)} onToggle={() => toggle(b.id)} onGone={() => remove(b.id)} onChange={replace} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function InboxRow({
  book,
  selected,
  onToggle,
  onGone,
  onChange,
}: {
  book: InboxItem;
  selected: boolean;
  onToggle: () => void;
  onGone: () => void;
  onChange: (b: InboxItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const action = useAction();

  const setRating = (rating: ContentRating) =>
    action.run(async () => {
      await adminApi.setRating(book.id, rating);
      onChange({ ...book, rating, ratingSource: "admin" });
    });

  return (
    <li className={`bb-inbox-row${selected ? " is-selected" : ""}`}>
      <input type="checkbox" className="bb-inbox-check" checked={selected} onChange={onToggle} aria-label={`Select ${book.title}`} />
      <Cover src={adminApi.coverUrl(book)} title={book.title} size={72} />
      <div className="bb-inbox-main">
        <div className="bb-inbox-title">
          <strong>{book.title}</strong>
          {book.subtitle ? <span className="bb-muted"> · {book.subtitle}</span> : null}
        </div>
        <div className="bb-muted bb-small">
          {book.authors.length ? book.authors.join(", ") : <em>No author</em>}
          {book.publishedYear ? ` · ${book.publishedYear}` : ""}
          {book.isbn13 ? ` · ISBN ${book.isbn13}` : ""} · added {timeAgo(book.addedAt)}
        </div>
        <div className="bb-inbox-files bb-small">
          {book.files.map((f) => (
            <span key={f.id} className="bb-file">
              <b>{f.format.toUpperCase()}</b> <code>{f.relPath}</code> {formatBytes(f.sizeBytes)}
            </span>
          ))}
        </div>
        {book.possibleDuplicates.length > 0 && (
          <div className="bb-dupe" role="note">
            Looks like a book you already have:
            {book.possibleDuplicates.map((d) => (
              <button
                key={d.id}
                className="bb-btn bb-btn-small"
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await adminApi.mergeBook(book.id, d.id);
                    onGone();
                  })
                }
                title="Adds this file to the existing book as another format, then removes this inbox entry"
              >
                Merge into “{d.title}”{d.approved ? "" : " (inbox)"}
              </button>
            ))}
          </div>
        )}
        {editing ? (
          <BookEditor
            book={book}
            onCancel={() => setEditing(false)}
            onSaved={(b) => {
              setEditing(false);
              onChange({ ...book, ...b });
            }}
          />
        ) : null}
        <ErrorNote error={action.error} />
      </div>
      <div className="bb-inbox-side">
        <div className="bb-small">
          Rating: <RatingPill rating={book.rating} source={book.ratingSource} />
        </div>
        <RatingButtons value={book.ratingSource === "admin" ? book.rating : null} onPick={setRating} disabled={action.busy} />
        <div className="bb-inbox-actions">
          <button
            className="bb-btn bb-btn-primary"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                await adminApi.approve([book.id]);
                onGone();
              })
            }
          >
            Approve{book.rating ? ` as ${SHORT_RATING[book.rating]}` : ""}
          </button>
          <button className="bb-btn" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
            Edit details
          </button>
          <button
            className="bb-btn"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                await adminApi.refreshMetadata(book.id);
              })
            }
            title="Look the book up on Hardcover, Google Books and Open Library again"
          >
            Look up online
          </button>
          {confirmReject ? (
            <span className="bb-confirm">
              Move the file to /books/.rejected?
              <button
                className="bb-btn bb-btn-danger"
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await adminApi.reject(book.id);
                    onGone();
                  })
                }
              >
                Reject
              </button>
              <button className="bb-btn bb-btn-ghost" onClick={() => setConfirmReject(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button className="bb-btn bb-btn-ghost" onClick={() => setConfirmReject(true)}>
              Reject…
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function ReviewPage() {
  const list = useLoad(() => adminApi.unrated());
  const items = list.data?.items ?? [];
  return (
    <>
      <h1 className="bb-h1">
        Needs a rating {list.data ? <span className="bb-count">{list.data.total}</span> : null}
      </h1>
      <p className="bb-muted bb-admin-lede">
        These books are in the library but nobody has rated them, so only grown-ups can see them. One tap rates a book and it
        shows up for every reader old enough.
      </p>
      <ErrorNote error={list.error} />
      {list.data && items.length === 0 ? (
        <BarnabyEmpty title="Every book has a rating" size={140} />
      ) : (
        <Card>
          <ul className="bb-review">
            {items.map((b) => (
              <ReviewRow
                key={b.id}
                id={b.id}
                title={b.title}
                authors={b.authors}
                year={b.publishedYear}
                cover={adminApi.coverUrl(b)}
                onRated={() => list.setData((d) => (d ? { ...d, items: d.items.filter((x) => x.id !== b.id), total: d.total - 1 } : d))}
              />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function ReviewRow(props: { id: string; title: string; authors: string[]; year: number | null; cover: string | null; onRated: () => void }) {
  const action = useAction();
  return (
    <li className="bb-review-row">
      <Cover src={props.cover} title={props.title} size={48} />
      <div className="bb-review-main">
        <strong>{props.title}</strong>
        <div className="bb-muted bb-small">
          {props.authors.join(", ") || "No author"}
          {props.year ? ` · ${props.year}` : ""}
        </div>
        <ErrorNote error={action.error} />
      </div>
      <RatingButtons
        value={null}
        disabled={action.busy}
        label={`Rate ${props.title}`}
        onPick={(r) =>
          action.run(async () => {
            await adminApi.setRating(props.id, r);
            props.onRated();
          })
        }
      />
    </li>
  );
}
