import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CONTENT_RATINGS, type ContentRating } from "@bookbandit/shared";
import { Cover, ErrorNote, RatingPill, SHORT_RATING, useAction, useLoad } from "../admin/ui";
import { CHECK_LABELS, HEALTH_CHECKS, librarianApi, type BulkChange, type HealthCheck, type LibBook } from "./api";
import { CoverEditor } from "./CoverEditor";
import { useDebounced } from "./HealthPage";

const PAGE = 50;
const FORMATS = ["epub", "kepub", "pdf", "mobi", "azw3", "fb2", "cbz", "cbr", "txt"];

/** Pick many books, then set series, tags, rating, authors or language on all of them at once. */
export function BooksPage() {
  const [params, setParams] = useSearchParams();
  const check = (params.get("check") as HealthCheck | null) ?? undefined;
  const format = params.get("format") ?? undefined;
  const [q, setQ] = useState(params.get("q") ?? "");
  const [offset, setOffset] = useState(0);
  const query = useDebounced(q);
  const list = useLoad(() => librarianApi.books({ q: query, check, format, offset, limit: PAGE }), [query, check, format, offset]);
  const series = useLoad(() => librarianApi.series());
  const [selected, setSelected] = useState<Map<string, LibBook>>(new Map());
  const [coverFor, setCoverFor] = useState<LibBook | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const items = list.data?.items ?? [];

  const setParam = (k: string, v: string | undefined) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setOffset(0);
  };
  const toggle = (b: LibBook) =>
    setSelected((s) => {
      const n = new Map(s);
      if (n.has(b.id)) n.delete(b.id);
      else n.set(b.id, b);
      return n;
    });
  const pageAllSelected = items.length > 0 && items.every((b) => selected.has(b.id));
  const replace = (updated: LibBook[]) => {
    const by = new Map(updated.map((b) => [b.id, b]));
    list.setData((d) => (d ? { ...d, items: d.items.map((b) => by.get(b.id) ?? b) } : d));
    setSelected((s) => new Map([...s].map(([id, b]) => [id, by.get(id) ?? b])));
  };

  return (
    <>
      <h1 className="bb-h1">
        Edit books {list.data ? <span className="bb-count">{list.data.total}</span> : null}
      </h1>
      <p className="bb-muted bb-admin-lede">Tick books (across pages and searches), then change them all at once. Tap a cover to change it.</p>

      <div className="bb-lib-filters">
        <input className="bb-input" type="search" placeholder="Search title, author or series" value={q} onChange={(e) => (setQ(e.target.value), setOffset(0))} aria-label="Search books" />
        <select className="bb-input" value={check ?? ""} onChange={(e) => setParam("check", e.target.value || undefined)} aria-label="Show only">
          <option value="">All books</option>
          {HEALTH_CHECKS.map((c) => (
            <option key={c} value={c}>
              {CHECK_LABELS[c].title}
            </option>
          ))}
        </select>
        <select className="bb-input" value={format ?? ""} onChange={(e) => setParam("format", e.target.value || undefined)} aria-label="Format">
          <option value="">Any format</option>
          {FORMATS.map((f) => (
            <option key={f} value={f}>
              Has {f.toUpperCase()}
            </option>
          ))}
        </select>
      </div>

      <BulkPanel
        selected={[...selected.values()]}
        seriesNames={series.data?.map((s) => s.name) ?? []}
        onClear={() => setSelected(new Map())}
        onApplied={(updated, msg) => {
          replace(updated);
          setNotice(msg);
          series.reload();
        }}
      />
      {notice && (
        <p className="bb-ok" role="status">
          {notice}
        </p>
      )}
      <ErrorNote error={list.error} />

      <div className="bb-lib-table" role="table" aria-label="Books">
        <div className="bb-lib-tr is-head" role="row">
          <span role="columnheader">
            <input
              type="checkbox"
              aria-label="Select this page"
              checked={pageAllSelected}
              onChange={() =>
                setSelected((s) => {
                  const n = new Map(s);
                  for (const b of items) pageAllSelected ? n.delete(b.id) : n.set(b.id, b);
                  return n;
                })
              }
            />
          </span>
          <span role="columnheader" />
          <span role="columnheader">Book</span>
          <span role="columnheader">Series</span>
          <span role="columnheader">Tags</span>
          <span role="columnheader">Rating</span>
          <span role="columnheader">Files</span>
        </div>
        {items.map((b) => (
          <div key={b.id} className={`bb-lib-tr${selected.has(b.id) ? " is-selected" : ""}`} role="row">
            <span role="cell">
              <input type="checkbox" checked={selected.has(b.id)} onChange={() => toggle(b)} aria-label={`Select ${b.title}`} />
            </span>
            <span role="cell">
              <button className="bb-lib-coverbtn" onClick={() => setCoverFor(b)} aria-label={`Change cover of ${b.title}`}>
                <Cover src={librarianApi.coverUrl(b)} title={b.title} size={40} />
              </button>
            </span>
            <span role="cell" className="bb-lib-title">
              <strong>{b.title}</strong>
              <span className="bb-muted bb-small">
                {b.authors.join(", ") || <em>No author</em>}
                {b.language ? ` · ${b.language}` : ""}
                {!b.approved ? " · in the inbox" : ""}
              </span>
            </span>
            <span role="cell" className="bb-small">
              {b.series ? (
                <>
                  {b.series.name}
                  {b.series.position != null ? <b> #{b.series.position}</b> : null}
                </>
              ) : (
                <span className="bb-muted">—</span>
              )}
            </span>
            <span role="cell" className="bb-lib-tags">
              {b.tags.slice(0, 3).map((t) => (
                <span key={t.name} className="bb-tag">
                  {t.name}
                </span>
              ))}
              {b.tags.length > 3 ? <span className="bb-muted bb-small">+{b.tags.length - 3}</span> : null}
            </span>
            <span role="cell">
              <RatingPill rating={b.rating} />
            </span>
            <span role="cell" className="bb-lib-formats">
              {b.files.length ? [...new Set(b.files.map((f) => f.format.toUpperCase()))].join(" · ") : <span className="bb-muted">none</span>}
            </span>
          </div>
        ))}
        {list.data && items.length === 0 && <p className="bb-muted bb-lib-none">No books match.</p>}
      </div>
      {list.data && list.data.total > PAGE && (
        <div className="bb-lib-pager">
          <button className="bb-btn bb-btn-small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Previous
          </button>
          <span className="bb-muted bb-small">
            {offset + 1}–{Math.min(offset + PAGE, list.data.total)} of {list.data.total}
          </span>
          <button className="bb-btn bb-btn-small" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>
            Next
          </button>
        </div>
      )}
      {coverFor && (
        <CoverEditor
          book={coverFor}
          onClose={() => setCoverFor(null)}
          onSaved={(b) => {
            replace([b]);
            setCoverFor(null);
          }}
        />
      )}
    </>
  );
}

type Field = "series" | "tags" | "rating" | "authors" | "language";

function BulkPanel({
  selected,
  seriesNames,
  onClear,
  onApplied,
}: {
  selected: LibBook[];
  seriesNames: string[];
  onClear: () => void;
  onApplied: (updated: LibBook[], message: string) => void;
}) {
  const [field, setField] = useState<Field>("series");
  const [seriesName, setSeriesName] = useState("");
  const [numbering, setNumbering] = useState<"keep" | "sequence" | "clear">("sequence");
  const [start, setStart] = useState(1);
  const [tagsAdd, setTagsAdd] = useState("");
  const [tagsRemove, setTagsRemove] = useState("");
  const [rating, setRating] = useState<ContentRating | "">("");
  const [authors, setAuthors] = useState("");
  const [language, setLanguage] = useState("");
  const act = useAction();
  const convert = useAction();
  const ids = useMemo(() => selected.map((b) => b.id), [selected]);
  if (!selected.length) return null;

  const split = (s: string) =>
    s
      .split(/[,;]/)
      .map((x) => x.trim())
      .filter(Boolean);

  const change = (): BulkChange | null => {
    switch (field) {
      case "series":
        return seriesName.trim() ? { ids, series: { name: seriesName.trim(), numbering, start } } : null;
      case "tags":
        return split(tagsAdd).length || split(tagsRemove).length ? { ids, tagsAdd: split(tagsAdd), tagsRemove: split(tagsRemove) } : null;
      case "rating":
        return rating ? { ids, rating } : null;
      case "authors":
        return split(authors).length ? { ids, authors: split(authors) } : null;
      case "language":
        return { ids, language: language.trim() || null };
    }
  };
  const c = change();
  const apply = (body: BulkChange) =>
    act.run(async () => {
      const r = await librarianApi.bulk(body);
      onApplied(r.items, `Updated ${r.updated} book${r.updated === 1 ? "" : "s"}${r.writeMetadataJobs ? `; writing details into ${r.writeMetadataJobs} EPUB${r.writeMetadataJobs === 1 ? "" : "s"}` : ""}.`);
    });

  return (
    <section className="bb-lib-bulk" aria-label="Change selected books">
      <header>
        <strong>{selected.length} selected</strong>
        <span className="bb-muted bb-small bb-lib-sel">{selected.slice(0, 4).map((b) => b.title).join(", ")}{selected.length > 4 ? "…" : ""}</span>
        <button className="bb-linkbtn" onClick={onClear}>
          Clear
        </button>
      </header>
      <div className="bb-chips" role="tablist" aria-label="What to change">
        {(["series", "tags", "rating", "authors", "language"] as Field[]).map((f) => (
          <button key={f} className="bb-chip" role="tab" aria-pressed={field === f} aria-selected={field === f} onClick={() => setField(f)}>
            {{ series: "Series", tags: "Tags", rating: "Rating", authors: "Author", language: "Language" }[f]}
          </button>
        ))}
      </div>
      <div className="bb-lib-bulk-body">
        {field === "series" && (
          <>
            <label className="bb-field">
              Series name
              <input className="bb-input" list="bb-series-names" value={seriesName} onChange={(e) => setSeriesName(e.target.value)} placeholder="Pebble Bay" />
              <datalist id="bb-series-names">
                {seriesNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </label>
            <label className="bb-field">
              Numbers
              <select className="bb-input" value={numbering} onChange={(e) => setNumbering(e.target.value as typeof numbering)}>
                <option value="sequence">Number them in the order picked</option>
                <option value="keep">Keep their numbers</option>
                <option value="clear">No numbers</option>
              </select>
            </label>
            {numbering === "sequence" && (
              <label className="bb-field bb-field-narrow">
                Start at
                <input className="bb-input" type="number" min={0} step={0.5} value={start} onChange={(e) => setStart(Number(e.target.value) || 0)} />
              </label>
            )}
            <button className="bb-btn bb-btn-small bb-btn-ghost bb-lib-remove" disabled={act.busy} onClick={() => apply({ ids, series: null })}>
              Take out of any series
            </button>
          </>
        )}
        {field === "tags" && (
          <>
            <label className="bb-field">
              Add tags
              <input className="bb-input" value={tagsAdd} onChange={(e) => setTagsAdd(e.target.value)} placeholder="Summer reading, Favorites" />
            </label>
            <label className="bb-field">
              Remove tags
              <input className="bb-input" value={tagsRemove} onChange={(e) => setTagsRemove(e.target.value)} placeholder="Comma-separated" />
            </label>
          </>
        )}
        {field === "rating" && (
          <div className="bb-rating-buttons" role="group" aria-label="Rating for selected books">
            {CONTENT_RATINGS.map((r) => (
              <button key={r} type="button" className={`bb-rating-btn is-${r}`} aria-pressed={rating === r} onClick={() => setRating(r)}>
                {SHORT_RATING[r]}
              </button>
            ))}
          </div>
        )}
        {field === "authors" && (
          <label className="bb-field bb-lib-wide">
            Authors (replaces the current ones)
            <input className="bb-input" value={authors} onChange={(e) => setAuthors(e.target.value)} placeholder="Ada Brightwater, Second Author" />
          </label>
        )}
        {field === "language" && (
          <label className="bb-field bb-field-narrow">
            Language code
            <input className="bb-input" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en" maxLength={16} />
          </label>
        )}
      </div>
      <ErrorNote error={act.error ?? convert.error} />
      <div className="bb-lib-bulk-actions">
        <button className="bb-btn bb-btn-primary" disabled={!c || act.busy} onClick={() => c && apply(c)}>
          Apply to {selected.length} book{selected.length === 1 ? "" : "s"}
        </button>
        <span className="bb-muted bb-small">or</span>
        <button
          className="bb-btn bb-btn-small"
          disabled={convert.busy}
          onClick={() =>
            convert.run(async () => {
              const r = await librarianApi.convert(ids);
              onApplied([], `Converting ${r.queued.length} to EPUB${r.skipped.length ? `; ${r.skipped.length} skipped (already EPUB or nothing to convert)` : ""}. Progress is under Convert.`);
            })
          }
        >
          Convert to EPUB
        </button>
        <button
          className="bb-btn bb-btn-small"
          disabled={convert.busy}
          onClick={() => convert.run(async () => (await librarianApi.prepareKobo(ids), onApplied([], `Preparing ${ids.length} for Kobo.`)))}
        >
          Prepare for Kobo
        </button>
      </div>
    </section>
  );
}
