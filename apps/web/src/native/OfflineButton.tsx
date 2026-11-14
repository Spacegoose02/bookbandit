import { useEffect, useState } from "react";
import type { BookDetail } from "../api/types";
import { pickReadableFile } from "../reader/formats";
import { nativeApp, type DownloadStatus } from "./native";

/** "Save for offline" on the book page, only inside the Android tablet app. */
export function OfflineButton({ book }: { book: BookDetail }) {
  const native = nativeApp();
  const file = pickReadableFile(book.files);
  const [status, setStatus] = useState<DownloadStatus>("none");
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!native) return;
    let live = true;
    native.downloadStatus(book.id).then((s) => live && setStatus(s), () => undefined);
    const off = native.onDownload((e) => {
      if (e.bookId !== book.id) return;
      setStatus(e.status);
      setPercent(e.total > 0 ? Math.round((e.received / e.total) * 100) : 0);
      setError(e.status === "error" ? (e.error ?? "The download failed") : null);
    });
    return () => {
      live = false;
      off();
    };
  }, [native, book.id]);

  if (!native || !file || book.kindleOnly) return null;

  if (status === "done") {
    return (
      <button type="button" className="bb-btn" onClick={() => void native.removeDownload(book.id).then(() => setStatus("none"))}>
        ✓ On this tablet · Remove
      </button>
    );
  }
  if (status === "queued" || status === "downloading") {
    return (
      <button type="button" className="bb-btn" disabled aria-live="polite">
        Saving… {percent > 0 ? `${percent}%` : ""}
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className="bb-btn"
        onClick={() => {
          setError(null);
          setStatus("queued");
          native.download(book.id, file.id).catch((e: unknown) => {
            setStatus("error");
            setError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));
          });
        }}
      >
        Save for offline
      </button>
      {error && <span className="bb-error bb-small">{error}</span>}
    </>
  );
}
