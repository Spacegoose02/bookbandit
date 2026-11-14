import { useEffect, useState, type FormEvent } from "react";
import type { AudioApi } from "./api";
import { formatTime } from "./timeline";
import type { AudioBookmark } from "./types";

/** Listening bookmarks with notes: add one at the current time, jump back, edit or delete. */
export function BookmarksPanel({
  api,
  bookId,
  now,
  onSeek,
  onCount,
}: {
  api: AudioApi;
  bookId: string;
  /** Current position, read when a bookmark is added. */
  now: () => number;
  onSeek: (t: number) => void;
  onCount?: (n: number) => void;
}) {
  const [items, setItems] = useState<AudioBookmark[] | null>(null);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.bookmarks(bookId).then(setItems, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, bookId]);
  useEffect(() => {
    if (items) onCount?.(items.length);
  }, [items, onCount]);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const b = await api.addBookmark(bookId, Math.floor(now()), note.trim() || undefined);
      setItems((list) => [...(list ?? []), b].sort((x, y) => x.time - y.time));
      setNote("");
    });
  };

  const save = (id: string) =>
    run(async () => {
      const b = await api.editBookmark(id, { note: draft.trim() || null });
      setItems((list) => (list ?? []).map((x) => (x.id === id ? b : x)));
      setEditing(null);
    });

  const remove = (id: string) =>
    run(async () => {
      await api.deleteBookmark(id);
      setItems((list) => (list ?? []).filter((x) => x.id !== id));
    });

  return (
    <section className="bb-listen-bookmarks" aria-label="Bookmarks">
      <form className="bb-listen-bookmark-add" onSubmit={add}>
        <input
          className="bb-input"
          placeholder={`Note for ${formatTime(now())} (optional)`}
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          aria-label="Bookmark note"
        />
        <button className="bb-btn bb-btn-primary">
          <span aria-hidden>🔖</span> Bookmark
        </button>
      </form>
      {error && <p className="bb-error">{error}</p>}
      {items && items.length === 0 && <p className="bb-muted bb-small">No bookmarks yet. Add one to come back to a favourite part.</p>}
      {items && items.length > 0 && (
        <ol className="bb-listen-bookmark-list">
          {items.map((b) => (
            <li key={b.id}>
              <button className="bb-listen-bookmark-time" onClick={() => onSeek(b.time)} aria-label={`Play from ${formatTime(b.time)}`}>
                {formatTime(b.time)}
              </button>
              {editing === b.id ? (
                <form
                  className="bb-listen-bookmark-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save(b.id);
                  }}
                >
                  <input className="bb-input" value={draft} autoFocus maxLength={2000} onChange={(e) => setDraft(e.target.value)} aria-label="Edit note" />
                  <button className="bb-btn">Save</button>
                  <button type="button" className="bb-btn bb-btn-ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span className="bb-listen-bookmark-note">
                    {b.note ?? <span className="bb-muted">No note</span>}
                    {b.origin === "audiobookshelf" && <span className="bb-muted bb-small"> · from Audiobookshelf</span>}
                  </span>
                  <span className="bb-listen-bookmark-actions">
                    <button className="bb-btn bb-btn-ghost" onClick={() => (setEditing(b.id), setDraft(b.note ?? ""))} aria-label="Edit note">
                      ✎
                    </button>
                    <button className="bb-btn bb-btn-ghost" onClick={() => void remove(b.id)} aria-label="Delete bookmark">
                      ✕
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
