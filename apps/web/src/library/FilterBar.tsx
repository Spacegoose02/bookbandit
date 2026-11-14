import { useEffect, useId, useState } from "react";
import type { ContentRating } from "@bookbandit/shared";
import { api } from "../api/client";
import {
  activeFilterCount,
  AGE_GROUP_LABELS,
  ageGroupOptions,
  EMPTY_FILTERS,
  SORT_KEYS,
  type LibraryFilters,
  type SortKey,
} from "./filters";

const SORT_LABELS: Record<SortKey, string> = { title: "Title", author: "Author", year: "Newest", added: "Recently added" };

export function FilterBar({
  value,
  onChange,
  maxRating,
}: {
  value: LibraryFilters;
  onChange(f: LibraryFilters): void;
  maxRating: ContentRating;
}) {
  const [open, setOpen] = useState(activeFilterCount(value) > (value.q ? 1 : 0));
  const [authors, setAuthors] = useState<string[]>([]);
  const listId = useId();
  const count = activeFilterCount(value);
  const groups = ageGroupOptions(maxRating);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .authors(value.author)
        .then((a) => setAuthors(a.map((x) => x.name)))
        .catch(() => setAuthors([]));
    }, 200);
    return () => clearTimeout(t);
  }, [value.author]);

  const set = (patch: Partial<LibraryFilters>) => onChange({ ...value, ...patch });
  const year = (v: string) => (v === "" ? null : Number.isInteger(Number(v)) ? Number(v) : null);
  const toggleRating = (r: ContentRating) =>
    set({ ratings: value.ratings.includes(r) ? value.ratings.filter((x) => x !== r) : [...value.ratings, r] });

  return (
    <section className="bb-filters" aria-label="Filters">
      <div className="bb-filters-row">
        <input
          className="bb-input bb-search"
          type="search"
          placeholder="Search titles and authors"
          aria-label="Search"
          value={value.q}
          onChange={(e) => set({ q: e.target.value })}
        />
        <select
          className="bb-input"
          aria-label="Sort by"
          value={value.sort}
          onChange={(e) => set({ sort: e.target.value as SortKey })}
        >
          {SORT_KEYS.map((k) => (
            <option key={k} value={k}>
              {SORT_LABELS[k]}
            </option>
          ))}
        </select>
        <button type="button" className="bb-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Filters{count ? ` (${count})` : ""}
        </button>
        {count > 0 && (
          <button type="button" className="bb-btn bb-btn-ghost" onClick={() => onChange({ ...EMPTY_FILTERS, shelf: value.shelf, sort: value.sort })}>
            Clear
          </button>
        )}
      </div>
      {open && (
        <div className="bb-filters-panel">
          <label className="bb-field">
            <span>Author</span>
            <input
              className="bb-input"
              list={listId}
              value={value.author}
              placeholder="Any author"
              onChange={(e) => set({ author: e.target.value })}
            />
            <datalist id={listId}>
              {authors.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </label>
          <fieldset className="bb-field">
            <legend>Published</legend>
            <div className="bb-year-range">
              <input
                className="bb-input"
                type="number"
                inputMode="numeric"
                placeholder="From"
                aria-label="From year"
                value={value.yearFrom ?? ""}
                onChange={(e) => set({ yearFrom: year(e.target.value) })}
              />
              <span aria-hidden>to</span>
              <input
                className="bb-input"
                type="number"
                inputMode="numeric"
                placeholder="To"
                aria-label="To year"
                value={value.yearTo ?? ""}
                onChange={(e) => set({ yearTo: year(e.target.value) })}
              />
            </div>
          </fieldset>
          {groups.length > 1 && (
            <fieldset className="bb-field">
              <legend>Age group</legend>
              <div className="bb-chips">
                {groups.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="bb-chip"
                    aria-pressed={value.ratings.includes(r)}
                    onClick={() => toggleRating(r)}
                  >
                    {AGE_GROUP_LABELS[r]}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
        </div>
      )}
    </section>
  );
}
