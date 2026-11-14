import { Link } from "react-router-dom";
import type { BookDetail } from "../api/types";

/** "Listen" on the book page, when the book has an audiobook (a local folder or Audiobookshelf). */
export function ListenButton({ book }: { book: Pick<BookDetail, "id" | "absItemId"> & { hasAudio?: boolean } }) {
  if (!book.hasAudio && !book.absItemId) return null;
  return (
    <Link className="bb-btn bb-btn-big" to={`/listen/${book.id}`}>
      <span aria-hidden>🎧</span> Listen
    </Link>
  );
}
