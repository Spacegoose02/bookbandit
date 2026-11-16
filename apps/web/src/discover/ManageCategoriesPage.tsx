import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, ErrorNote, useAction, useLoad } from "../admin/ui";
import { discoverApi, type CategoryKind, type ManagedCategory } from "./api";
import "./discover.css";

type View = "categories" | "subject";

const KIND_LABEL: Record<CategoryKind, string> = {
  genre: "Category",
  subject: "Subject",
  section: "Home shelf",
  custom: "Household tag",
};

function status(c: ManagedCategory, minBooks: number): { label: string; tone: "ok" | "muted" | "warn" } {
  if (c.kind === "subject") return { label: "Search only", tone: "muted" };
  if (c.hidden) return { label: "Hidden", tone: "warn" };
  if (!c.shown && c.kind === "genre" && c.bookCount < minBooks) return { label: `Under ${minBooks} books`, tone: "muted" };
  return { label: "Shown", tone: "ok" };
}

/**
 * Admin page for tidying categories: rename, merge, hide, promote a subject, and choose how many
 * books a category needs before it gets a tile. Server: docs/discover-api.md.
 */
export function ManageCategoriesPage() {
  const [view, setView] = useState<View>("categories");
  const [q, setQ] = useState("");
  const list = useLoad(() => discoverApi.manageCategories(view === "subject" ? "subject" : "categories", q.trim() || undefined), [view, q]);
  const targets = useLoad(() => discoverApi.manageCategories("categories"), []);
  const act = useAction();
  const [note, setNote] = useState<string | null>(null);
  const [minDraft, setMinDraft] = useState<string | null>(null);

  const d = list.data;
  const minBooks = d?.minBooks ?? 3;
  const rows = (d?.items ?? []).filter((c) => (view === "subject" ? c.kind === "subject" : c.kind !== "subject"));
  const mergeTargets = targets.data?.items ?? [];
  const shownCount = (d?.items ?? []).filter((c) => c.shown).length;

  const run = (fn: () => Promise<unknown>, done?: string) =>
    act.run(async () => {
      await fn();
      setNote(done ?? null);
      list.reload();
      targets.reload();
    });

  return (
    <>
      <h1 className="bb-h1">Categories</h1>
      <p className="bb-muted bb-admin-lede">
        Books are filed under a short list of categories worked out from their metadata. The raw subjects that sources send
        (Open Library alone sends dozens a book) are kept for search and Barnaby, but don't get their own tile. Merge, rename
        or hide anything here; the choice sticks when books are rescanned.{" "}
        <Link className="bb-link" to="/categories">
          See the Categories page
        </Link>
      </p>

      <Card
        title="How categories are listed"
        actions={
          <button
            className="bb-btn"
            disabled={act.busy}
            onClick={() =>
              run(async () => {
                const r = await discoverApi.rebuildCategories();
                setNote(
                  `Re-filed ${r.books} books (${r.linked} new links${r.refiled ? `, ${r.refiled} moved between Fiction and Nonfiction` : ""}).` +
                    (r.rechecking ? ` Looking up ${r.rechecking} unsure books online to tell fiction from nonfiction.` : ""),
                );
              })
            }
          >
            Re-file all books
          </button>
        }
      >
        <form
          className="bb-mcat-settings"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(minDraft);
            if (Number.isInteger(n) && n >= 1) run(() => discoverApi.setCategoryMinBooks(n), `Categories need ${n}+ books now.`).then(() => setMinDraft(null));
          }}
        >
          <label className="bb-field">
            <span>Hide categories with fewer than</span>
            <span className="bb-mcat-min">
              <input
                className="bb-input"
                type="number"
                min={1}
                max={100}
                value={minDraft ?? String(minBooks)}
                onChange={(e) => setMinDraft(e.target.value)}
                aria-label="Minimum books"
              />
              books
            </span>
          </label>
          {minDraft !== null && minDraft !== String(minBooks) && (
            <button className="bb-btn bb-btn-primary" disabled={act.busy}>
              Save
            </button>
          )}
          {d && (
            <p className="bb-small bb-muted">
              {shownCount} on the Categories page · {d.counts.subject ?? 0} raw subjects kept for search
            </p>
          )}
        </form>
      </Card>

      <div className="bb-mcat-bar">
        <div className="bb-mcat-tabs" role="tablist">
          <button role="tab" aria-selected={view === "categories"} className={view === "categories" ? "active" : ""} onClick={() => setView("categories")}>
            Categories
          </button>
          <button role="tab" aria-selected={view === "subject"} className={view === "subject" ? "active" : ""} onClick={() => setView("subject")}>
            Raw subjects
          </button>
        </div>
        <input className="bb-input" type="search" placeholder="Find…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a category" />
      </div>
      {note && <p className="bb-mcat-note">{note}</p>}
      <ErrorNote error={list.error ?? act.error} />

      <div className="bb-mcat-table">
        <div className="bb-mcat-tr is-head">
          <span>Name</span>
          <span>Books</span>
          <span>Status</span>
          <span>Actions</span>
        </div>
        {rows.map((c) => (
          <Row key={c.id} c={c} minBooks={minBooks} targets={mergeTargets} busy={act.busy} run={run} />
        ))}
        {d && !rows.length && <p className="bb-muted bb-mcat-empty">Nothing matches.</p>}
      </div>
    </>
  );
}

function Row({
  c,
  minBooks,
  targets,
  busy,
  run,
}: {
  c: ManagedCategory;
  minBooks: number;
  targets: ManagedCategory[];
  busy: boolean;
  run: (fn: () => Promise<unknown>, done?: string) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<"rename" | "merge" | null>(null);
  const [name, setName] = useState(c.name);
  const [into, setInto] = useState("");
  const s = status(c, minBooks);
  const canPromote = c.kind === "genre" || c.kind === "subject";

  return (
    <div className={`bb-mcat-tr${c.shown ? "" : " is-dim"}`}>
      <span className="bb-mcat-name">
        {mode === "rename" ? (
          <form
            className="bb-mcat-inline"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== c.name) run(() => discoverApi.updateCategory(c.id, { name: name.trim() }), `Renamed to ${name.trim()}.`);
              setMode(null);
            }}
          >
            <input className="bb-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="New name" />
            <button className="bb-btn bb-btn-primary">Save</button>
            <button type="button" className="bb-btn bb-btn-ghost" onClick={() => setMode(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <b>{c.name}</b>
            <span className="bb-small bb-muted">
              {KIND_LABEL[c.kind]}
              {c.curated && " · built in"}
              {c.aliases.length > 0 && ` · also "${c.aliases.slice(0, 3).join('", "')}"${c.aliases.length > 3 ? "…" : ""}`}
            </span>
          </>
        )}
        {mode === "merge" && (
          <form
            className="bb-mcat-inline"
            onSubmit={(e) => {
              e.preventDefault();
              const t = targets.find((x) => x.id === into);
              if (t) run(() => discoverApi.mergeCategory(c.id, t.id), `Merged ${c.name} into ${t.name}.`);
              setMode(null);
            }}
          >
            <select className="bb-input" value={into} onChange={(e) => setInto(e.target.value)} aria-label={`Merge ${c.name} into`}>
              <option value="">Merge into…</option>
              {targets
                .filter((t) => t.id !== c.id)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.bookCount})
                  </option>
                ))}
            </select>
            <button className="bb-btn bb-btn-primary" disabled={!into}>
              Merge
            </button>
            <button type="button" className="bb-btn bb-btn-ghost" onClick={() => setMode(null)}>
              Cancel
            </button>
          </form>
        )}
      </span>
      <span>{c.bookCount}</span>
      <span>
        <span className={`bb-mcat-status is-${s.tone}`}>{s.label}</span>
      </span>
      <span className="bb-mcat-actions">
        {c.kind !== "subject" && (
          <button className="bb-mcat-link" disabled={busy} onClick={() => run(() => discoverApi.updateCategory(c.id, { hidden: !c.hidden }))}>
            {c.hidden ? "Show" : "Hide"}
          </button>
        )}
        <button className="bb-mcat-link" disabled={busy} onClick={() => setMode(mode === "rename" ? null : "rename")}>
          Rename
        </button>
        <button className="bb-mcat-link" disabled={busy} onClick={() => setMode(mode === "merge" ? null : "merge")}>
          Merge
        </button>
        {canPromote && (
          <button
            className="bb-mcat-link"
            disabled={busy}
            onClick={() =>
              run(
                () => discoverApi.updateCategory(c.id, { kind: c.kind === "subject" ? "genre" : "subject" }),
                c.kind === "subject" ? `${c.name} is a category now.` : `${c.name} is a search-only subject now.`,
              )
            }
          >
            {c.kind === "subject" ? "Make a category" : "Search only"}
          </button>
        )}
      </span>
    </div>
  );
}
