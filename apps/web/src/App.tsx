import { useEffect, useState } from "react";

interface BookSummary {
  id: string;
  title: string;
}

/** Placeholder home screen. The web workstream replaces this with shelves and the reader. */
export function App() {
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/books")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { items: BookSummary[] }) => setBooks(data.items))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>Bookbandit</h1>
      {error && <p>Couldn't load books: {error}</p>}
      {books && (books.length ? <ul>{books.map((b) => <li key={b.id}>{b.title}</li>)}</ul> : <p>No books yet.</p>)}
    </main>
  );
}
