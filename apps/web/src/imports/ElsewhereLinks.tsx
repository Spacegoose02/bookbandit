import { useEffect, useState } from "react";
import { importsApi } from "./api";

/**
 * "Open in Google Play Books" on the book page, for books imported from a Play Books library.
 * Renders nothing for other books. The server checks the content lock (404 for locked books).
 */
export function ElsewhereLinks({ bookId, hasFiles }: { bookId: string; hasFiles: boolean }) {
  const [play, setPlay] = useState<{ url: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    setPlay(null);
    importsApi.elsewhere(bookId).then(
      (r) => live && setPlay(r.googlePlay),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [bookId]);
  if (!play?.url) return null;
  return (
    <a className={`bb-btn bb-btn-big${hasFiles ? "" : " bb-btn-primary"}`} href={play.url} target="_blank" rel="noreferrer">
      Open in Google Play Books
    </a>
  );
}
