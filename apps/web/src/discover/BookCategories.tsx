import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { discoverApi } from "./api";
import "./discover.css";

type BookCats = Awaited<ReturnType<typeof discoverApi.bookCategories>>;

/** A book's categories (and whether it's a cookbook), for the book page. */
export function useBookCategories(bookId: string | null): BookCats | null {
  const [cats, setCats] = useState<BookCats | null>(null);
  useEffect(() => {
    setCats(null);
    if (!bookId) return;
    let live = true;
    discoverApi
      .bookCategories(bookId)
      .then((c) => live && setCats(c))
      .catch(() => live && setCats(null));
    return () => {
      live = false;
    };
  }, [bookId]);
  return cats;
}

export function BookCategories({ categories }: { categories: BookCats | null }) {
  if (!categories?.items.length) return null;
  return (
    <div className="bb-chips bb-book-cats" aria-label="Categories">
      {categories.items.slice(0, 12).map((c) => (
        <Link key={c.id} className="bb-chip bb-chip-link" to={`/categories/${encodeURIComponent(c.id)}`}>
          {c.name}
        </Link>
      ))}
    </div>
  );
}
