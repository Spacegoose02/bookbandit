import { useState, type FormEvent } from "react";
import type { AdminBook, BookPatch, InboxItem } from "./api";
import { adminApi } from "./api";
import { ErrorNote, useAction } from "./ui";

type Editable = Pick<InboxItem | AdminBook, "id" | "title" | "subtitle" | "authors" | "publishedYear" | "isbn13" | "description">;

/** Inline form for fixing a book's details before (or after) it's approved. */
export function BookEditor({ book, onSaved, onCancel }: { book: Editable; onSaved: (b: AdminBook) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(book.title);
  const [subtitle, setSubtitle] = useState(book.subtitle ?? "");
  const [authors, setAuthors] = useState(book.authors.join(", "));
  const [year, setYear] = useState(book.publishedYear?.toString() ?? "");
  const [isbn, setIsbn] = useState(book.isbn13 ?? "");
  const [description, setDescription] = useState(book.description ?? "");
  const action = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const patch: BookPatch = {
      title: title.trim(),
      subtitle: subtitle.trim() || null,
      authors: authors
        .split(/[,;]/)
        .map((a) => a.trim())
        .filter(Boolean),
      publishedYear: year.trim() ? Number(year) : null,
      isbn13: isbn.trim() || null,
      description: description.trim() || null,
    };
    void action.run(async () => onSaved(await adminApi.editBook(book.id, patch)));
  };

  return (
    <form className="bb-book-editor" onSubmit={submit}>
      <label className="bb-field">
        Title
        <input className="bb-input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={500} />
      </label>
      <label className="bb-field">
        Subtitle
        <input className="bb-input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} maxLength={500} />
      </label>
      <label className="bb-field">
        Authors <span className="bb-muted bb-small">(comma between names)</span>
        <input className="bb-input" value={authors} onChange={(e) => setAuthors(e.target.value)} />
      </label>
      <div className="bb-form-row">
        <label className="bb-field">
          Year
          <input className="bb-input" inputMode="numeric" pattern="\d{1,4}" value={year} onChange={(e) => setYear(e.target.value)} />
        </label>
        <label className="bb-field">
          ISBN-13
          <input className="bb-input" inputMode="numeric" value={isbn} onChange={(e) => setIsbn(e.target.value)} placeholder="978…" />
        </label>
      </div>
      <label className="bb-field">
        Description
        <textarea className="bb-input bb-textarea" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <ErrorNote error={action.error} />
      <div className="bb-form-actions">
        <button className="bb-btn bb-btn-primary" disabled={action.busy}>
          Save details
        </button>
        <button type="button" className="bb-btn bb-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
