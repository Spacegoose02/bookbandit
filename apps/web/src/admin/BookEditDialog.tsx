import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CONTENT_RATINGS, RATING_LABELS, type BookLockField, type ContentRating } from "@bookbandit/shared";
import { adminApi, type BookPatch, type EditableBook } from "./api";
import { ErrorNote, useAction, useLoad } from "./ui";
import { CoverEditor } from "../librarian/CoverEditor";
import { librarianApi, type LibBook } from "../librarian/api";
import "./book-edit.css";

type Tab = "details" | "tags" | "artwork" | "advanced";
const TABS: [Tab, string][] = [
  ["details", "Details"],
  ["tags", "Tags"],
  ["artwork", "Artwork"],
  ["advanced", "Advanced"],
];

const FICTION = "Fiction";
const NONFICTION = "Nonfiction";

/** Text form of every editable field, so inputs stay controlled and "changed" is a string compare. */
interface Form {
  title: string;
  sortTitle: string;
  originalTitle: string;
  subtitle: string;
  authors: string;
  seriesName: string;
  seriesPosition: string;
  publishedYear: string;
  publisher: string;
  rating: string;
  description: string;
  isbn13: string;
  language: string;
  pageCount: string;
  hardcoverId: string;
  openLibraryId: string;
  googleBooksId: string;
}

/** Which lock each form field belongs to. */
const FIELD_LOCK: Record<keyof Form, BookLockField | null> = {
  title: "title",
  sortTitle: "sortTitle",
  originalTitle: "originalTitle",
  subtitle: "subtitle",
  authors: "authors",
  seriesName: "series",
  seriesPosition: "series",
  publishedYear: "publishedYear",
  publisher: "publisher",
  rating: "rating",
  description: "description",
  isbn13: "isbn13",
  language: "language",
  pageCount: "pageCount",
  hardcoverId: null,
  openLibraryId: null,
  googleBooksId: null,
};

function formOf(b: EditableBook): Form {
  const s = b.series[0];
  return {
    title: b.title,
    sortTitle: b.sortTitle,
    originalTitle: b.originalTitle ?? "",
    subtitle: b.subtitle ?? "",
    authors: b.authors.join(", "),
    seriesName: s?.name ?? "",
    seriesPosition: s?.position != null ? String(s.position) : "",
    publishedYear: b.publishedYear != null ? String(b.publishedYear) : "",
    publisher: b.publisher ?? "",
    rating: b.rating ?? "",
    description: b.description ?? "",
    isbn13: b.isbn13 ?? "",
    language: b.language ?? "",
    pageCount: b.pageCount != null ? String(b.pageCount) : "",
    hardcoverId: b.hardcoverId ?? "",
    openLibraryId: b.openLibraryId ?? "",
    googleBooksId: b.googleBooksId ?? "",
  };
}

const categoriesOf = (b: EditableBook) => b.tags.filter((t) => t.kind === "genre").map((t) => t.name);
const orNull = (s: string) => (s.trim() ? s.trim() : null);
const numOrNull = (s: string) => (s.trim() ? Number(s) : null);

/** Only what changed, as a patch the server takes. */
function patchOf(before: Form, after: Form, catsBefore: string[], catsAfter: string[]): BookPatch {
  const p: BookPatch = {};
  const changed = (k: keyof Form) => before[k] !== after[k];
  if (changed("title")) p.title = after.title.trim();
  if (changed("sortTitle") && after.sortTitle.trim()) p.sortTitle = after.sortTitle.trim();
  if (changed("originalTitle")) p.originalTitle = orNull(after.originalTitle);
  if (changed("subtitle")) p.subtitle = orNull(after.subtitle);
  if (changed("authors"))
    p.authors = after.authors
      .split(/[,;]/)
      .map((a) => a.trim())
      .filter(Boolean);
  if (changed("seriesName") || changed("seriesPosition"))
    p.series = after.seriesName.trim() ? { name: after.seriesName.trim(), position: numOrNull(after.seriesPosition) } : null;
  if (changed("publishedYear")) p.publishedYear = numOrNull(after.publishedYear);
  if (changed("publisher")) p.publisher = orNull(after.publisher);
  if (changed("rating")) p.rating = (after.rating || null) as ContentRating | null;
  if (changed("description")) p.description = orNull(after.description);
  if (changed("isbn13")) p.isbn13 = orNull(after.isbn13);
  if (changed("language")) p.language = orNull(after.language);
  if (changed("pageCount")) p.pageCount = numOrNull(after.pageCount);
  if (changed("hardcoverId")) p.hardcoverId = orNull(after.hardcoverId);
  if (changed("openLibraryId")) p.openLibraryId = orNull(after.openLibraryId);
  if (changed("googleBooksId")) p.googleBooksId = orNull(after.googleBooksId);
  if ([...catsBefore].sort().join("|") !== [...catsAfter].sort().join("|")) p.categories = catsAfter;
  return p;
}

/**
 * The book editor: Details, Tags (categories and fiction / nonfiction), Artwork and Advanced.
 * Each field has a lock; editing a field locks it, and locked fields keep their value when
 * metadata is refreshed, the library is rescanned or Calibre is imported again.
 */
export function BookEditDialog({ bookId, onClose, onSaved }: { bookId: string; onClose: () => void; onSaved: (b: EditableBook) => void }) {
  const loaded = useLoad(() => adminApi.book(bookId), [bookId]);
  const names = useLoad(() => adminApi.categoryNames(), []);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal?.();
  }, []);

  return (
    <dialog ref={dialog} className="bb-edit-dialog" aria-label="Edit book" onCancel={onClose}>
      {loaded.data ? (
        <EditForm book={loaded.data} names={names.data ?? []} onClose={onClose} onSaved={onSaved} onBookChange={loaded.setData} />
      ) : (
        <div className="bb-edit-loading">
          {loaded.error ? <ErrorNote error={loaded.error} /> : <p className="bb-muted">Loading…</p>}
          <button className="bb-btn" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </dialog>
  );
}

function EditForm({
  book,
  names,
  onClose,
  onSaved,
  onBookChange,
}: {
  book: EditableBook;
  names: string[];
  onClose: () => void;
  onSaved: (b: EditableBook) => void;
  onBookChange: (b: EditableBook) => void;
}) {
  const initial = useMemo(() => formOf(book), [book.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const initialCats = useMemo(() => categoriesOf(book), [book.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tab, setTab] = useState<Tab>("details");
  const [form, setForm] = useState<Form>(initial);
  const [cats, setCats] = useState<string[]>(initialCats);
  const [locks, setLocks] = useState<Set<BookLockField>>(new Set(book.lockedFields));
  const [newCat, setNewCat] = useState("");
  const [cover, setCover] = useState(false);
  const save = useAction();

  const lock = (f: BookLockField) => setLocks((l) => (l.has(f) ? l : new Set(l).add(f)));
  const toggleLock = (f: BookLockField) =>
    setLocks((l) => {
      const n = new Set(l);
      if (n.has(f)) n.delete(f);
      else n.add(f);
      return n;
    });
  const set = (k: keyof Form) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    const l = FIELD_LOCK[k];
    if (l) lock(l);
  };
  const setCategories = (next: string[]) => {
    setCats(next);
    lock("categories");
  };

  const kind = cats.includes(FICTION) ? "fiction" : cats.includes(NONFICTION) ? "nonfiction" : "";
  const setKind = (k: string) => {
    const rest = cats.filter((c) => c !== FICTION && c !== NONFICTION);
    setCategories(k === "fiction" ? [...rest, FICTION] : k === "nonfiction" ? [...rest, NONFICTION] : rest);
  };
  const genres = cats.filter((c) => c !== FICTION && c !== NONFICTION);
  const addCat = () => {
    const name = newCat.trim();
    if (!name) return;
    const known = names.find((n) => n.toLowerCase() === name.toLowerCase()) ?? name;
    if (!cats.some((c) => c.toLowerCase() === known.toLowerCase())) setCategories([...cats, known]);
    setNewCat("");
  };

  const submit = () =>
    save.run(async () => {
      const patch = patchOf(initial, form, initialCats, cats);
      const saved = await adminApi.editBook(book.id, { ...patch, locks: [...locks] });
      onSaved(saved);
    });

  const field = (k: keyof Form, label: string, input: ReactNode, wide = false) => {
    const l = FIELD_LOCK[k];
    return (
      <div className={`bb-edit-field${wide ? " is-wide" : ""}`}>
        <div className="bb-edit-label">
          <label htmlFor={`bb-edit-${k}`}>{label}</label>
          {l && <LockButton locked={locks.has(l)} label={label} onClick={() => toggleLock(l)} />}
        </div>
        {input}
      </div>
    );
  };
  const text = (k: keyof Form, opts: { placeholder?: string; inputMode?: "numeric" | "decimal"; maxLength?: number } = {}) => (
    <input
      id={`bb-edit-${k}`}
      className="bb-input"
      value={form[k]}
      onChange={(e) => set(k)(e.target.value)}
      placeholder={opts.placeholder}
      inputMode={opts.inputMode}
      maxLength={opts.maxLength ?? 500}
    />
  );

  const libBook = { ...book, series: book.series[0] ?? null } as unknown as LibBook;

  return (
    <>
      <header className="bb-edit-head">
        <h2>Edit {book.title}</h2>
        <button className="bb-icon-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="bb-edit-tabs" role="tablist">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`bb-edit-tab${tab === t ? " is-active" : ""}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      <div className="bb-edit-body">
        {tab === "details" && (
          <div className="bb-edit-grid">
            {field("title", "Title", text("title"))}
            {field("sortTitle", "Sort title", text("sortTitle"))}
            {field("originalTitle", "Original title", text("originalTitle", { placeholder: "If it was first published under another name" }))}
            {field("subtitle", "Subtitle", text("subtitle"))}
            {field("authors", "Authors", text("authors", { placeholder: "Comma between names" }), true)}
            {field("seriesName", "Series", text("seriesName", { placeholder: "Not in a series", maxLength: 200 }))}
            {field("seriesPosition", "Number in series", text("seriesPosition", { inputMode: "decimal", placeholder: "1" }))}
            {field("publishedYear", "Published (year)", text("publishedYear", { inputMode: "numeric", maxLength: 4 }))}
            {field("publisher", "Publisher", text("publisher", { maxLength: 200 }))}
            {field(
              "rating",
              "Age group",
              <select id="bb-edit-rating" className="bb-input" value={form.rating} onChange={(e) => set("rating")(e.target.value)}>
                <option value="">Unrated (hidden from kids)</option>
                {CONTENT_RATINGS.map((r) => (
                  <option key={r} value={r}>
                    {RATING_LABELS[r]}
                  </option>
                ))}
              </select>,
            )}
            {field(
              "description",
              "Description",
              <textarea id="bb-edit-description" className="bb-input bb-edit-textarea" rows={5} value={form.description} onChange={(e) => set("description")(e.target.value)} />,
              true,
            )}
          </div>
        )}

        {tab === "tags" && (
          <div className="bb-edit-tags">
            <div className="bb-edit-label">
              <span>Fiction or nonfiction</span>
              <LockButton locked={locks.has("categories")} label="Categories" onClick={() => toggleLock("categories")} />
            </div>
            <div className="bb-edit-seg" role="radiogroup" aria-label="Fiction or nonfiction">
              {[
                ["fiction", "Fiction"],
                ["nonfiction", "Nonfiction"],
                ["", "Not set"],
              ].map(([v, label]) => (
                <button key={v} role="radio" aria-checked={kind === v} className={`bb-edit-seg-btn${kind === v ? " is-active" : ""}`} onClick={() => setKind(v!)}>
                  {label}
                </button>
              ))}
            </div>

            <div className="bb-edit-label">
              <span>Categories</span>
            </div>
            <div className="bb-edit-chips">
              {genres.length === 0 && <span className="bb-muted bb-small">No categories yet.</span>}
              {genres.map((c) => (
                <span key={c} className="bb-edit-chip">
                  {c}
                  <button aria-label={`Remove ${c}`} onClick={() => setCategories(cats.filter((x) => x !== c))}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <form
              className="bb-edit-add"
              onSubmit={(e) => {
                e.preventDefault();
                addCat();
              }}
            >
              <input
                className="bb-input"
                list="bb-edit-cat-names"
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                placeholder="Add a category…"
                aria-label="Add a category"
                maxLength={60}
              />
              <datalist id="bb-edit-cat-names">
                {names
                  .filter((n) => n !== FICTION && n !== NONFICTION && !cats.includes(n))
                  .map((n) => (
                    <option key={n} value={n} />
                  ))}
              </datalist>
              <button className="bb-btn" disabled={!newCat.trim()}>
                Add
              </button>
            </form>
            <p className="bb-muted bb-small">
              Changing these locks the categories, so the automatic sorter won't move this book again. Unlock to let it decide.
            </p>
            {book.tags.some((t) => t.kind === "subject") && (
              <p className="bb-muted bb-small">
                Subjects from metadata (search only):{" "}
                {book.tags
                  .filter((t) => t.kind === "subject")
                  .map((t) => t.name)
                  .join(", ")}
              </p>
            )}
          </div>
        )}

        {tab === "artwork" && (
          <div className="bb-edit-artwork">
            <div className="bb-edit-cover">
              {librarianApi.coverUrl(book) ? <img src={librarianApi.coverUrl(book)!} alt="" /> : <div className="bb-cover bb-cover-blank">{book.title}</div>}
            </div>
            <div>
              <div className="bb-edit-label">
                <span>Cover</span>
                <LockButton locked={locks.has("cover")} label="Cover" onClick={() => toggleLock("cover")} />
              </div>
              <p className="bb-muted bb-small">Pick a cover from the book's files or an online lookup, upload your own, or crop this one. A new cover is locked.</p>
              <button className="bb-btn" onClick={() => setCover(true)}>
                Change cover…
              </button>
            </div>
          </div>
        )}

        {tab === "advanced" && (
          <div className="bb-edit-grid">
            {field("isbn13", "ISBN-13", text("isbn13", { inputMode: "numeric", placeholder: "978…", maxLength: 17 }))}
            {field("language", "Language", text("language", { placeholder: "en", maxLength: 20 }))}
            {field("pageCount", "Pages", text("pageCount", { inputMode: "numeric", maxLength: 6 }))}
            {field("hardcoverId", "Hardcover id", text("hardcoverId", { maxLength: 100 }))}
            {field("openLibraryId", "Open Library id", text("openLibraryId", { maxLength: 100 }))}
            {field("googleBooksId", "Google Books id", text("googleBooksId", { maxLength: 100 }))}
            <div className="bb-edit-field is-wide">
              <p className="bb-muted bb-small">
                Files: {book.files.length ? book.files.map((f) => f.relPath).join(", ") : "none (Kindle or metadata-only book)"}
              </p>
            </div>
          </div>
        )}
      </div>

      <footer className="bb-edit-foot">
        <span className="bb-muted bb-small">
          <LockIcon locked /> Locked fields keep your edits when metadata is refreshed.
        </span>
        <ErrorNote error={save.error} />
        <div className="bb-edit-actions">
          <button className="bb-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="bb-btn bb-btn-primary" onClick={() => void submit()} disabled={save.busy || !form.title.trim()}>
            {save.busy ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>

      {cover && (
        <CoverEditor
          book={libBook}
          onClose={() => setCover(false)}
          onSaved={(b) => {
            setCover(false);
            lock("cover");
            onBookChange({ ...book, coverPath: b.coverPath, updatedAt: b.updatedAt ?? Date.now() });
          }}
        />
      )}
    </>
  );
}

function LockButton({ locked, label, onClick }: { locked: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`bb-edit-lock${locked ? " is-locked" : ""}`}
      onClick={onClick}
      aria-pressed={locked}
      aria-label={`${locked ? "Unlock" : "Lock"} ${label}`}
      title={locked ? "Locked: refreshes keep this value. Click to unlock." : "Unlocked: refreshes may fill this in. Click to lock."}
    >
      <LockIcon locked={locked} />
    </button>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" className="bb-lock-icon">
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d={locked ? "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" : "M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
