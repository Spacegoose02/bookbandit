import { useEffect, useState } from "react";
import { Bar, Card, Cover, ErrorNote, formatBytes, timeAgo, useAction, useLoad } from "../admin/ui";
import { librarianApi } from "./api";

/** Convert MOBI/AZW3/FB2 to EPUB, prepare EPUBs for Kobo, and optionally write details into EPUBs. */
export function ConvertPage() {
  const tools = useLoad(() => librarianApi.tools());
  const books = useLoad(() => librarianApi.convertible());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const act = useAction();
  const [notice, setNotice] = useState<string | null>(null);
  const t = tools.data;
  const active = t?.jobs.some((j) => j.status === "queued" || j.status === "running");

  useEffect(() => {
    if (!active) return;
    const h = setTimeout(() => (tools.reload(), books.reload()), 2000);
    return () => clearTimeout(h);
  }, [active, tools.data, tools.reload, books.reload]);

  const list = books.data ?? [];
  const convert = (ids: string[]) =>
    act.run(async () => {
      const r = await librarianApi.convert(ids);
      setNotice(`Converting ${r.queued.length} book${r.queued.length === 1 ? "" : "s"} to EPUB.`);
      setSelected(new Set());
      tools.reload();
    });

  return (
    <>
      <h1 className="bb-h1">Convert</h1>
      <p className="bb-muted bb-admin-lede">
        Conversions run in the background with Calibre's <code>ebook-convert</code>. The new EPUB is saved next to the original in
        your books folder and joins the same book; the original stays as it was. DRM-protected files are never converted.
      </p>
      <ErrorNote error={tools.error ?? books.error ?? act.error} />
      {notice && (
        <p className="bb-ok" role="status">
          {notice}
        </p>
      )}

      {t && (
        <div className="bb-tiles">
          <div className={`bb-tile${t.ebookConvert ? "" : " is-warn"}`}>
            <span className="bb-tile-value">{t.ebookConvert ? "Ready" : "Missing"}</span>
            <span className="bb-tile-label">ebook-convert</span>
            <span className="bb-tile-hint">{t.ebookConvert ? "Calibre's converter is installed" : "In the Docker image; set EBOOK_CONVERT_PATH otherwise"}</span>
          </div>
          <div className={`bb-tile${t.kepubify ? "" : " is-warn"}`}>
            <span className="bb-tile-value">{t.kepubify ? "Ready" : "Missing"}</span>
            <span className="bb-tile-label">kepubify</span>
            <span className="bb-tile-hint">{t.kepubify ? "Kobo copies can be made ahead of time" : "In the Docker image; set KEPUBIFY_PATH otherwise"}</span>
          </div>
          <div className={`bb-tile${t.needsConversion ? " is-warn" : ""}`}>
            <span className="bb-tile-value">{t.needsConversion}</span>
            <span className="bb-tile-label">Without an EPUB</span>
            <span className="bb-tile-hint">Only MOBI, AZW3, FB2 or TXT, which the reader can't open</span>
          </div>
        </div>
      )}

      <Card
        title="Books to convert"
        actions={
          list.length > 0 && (
            <button className="bb-btn bb-btn-small bb-btn-primary" disabled={act.busy || !t?.ebookConvert} onClick={() => convert(selected.size ? [...selected] : list.map((b) => b.id))}>
              {selected.size ? `Convert ${selected.size} to EPUB` : `Convert all ${list.length} to EPUB`}
            </button>
          )
        }
      >
        {books.data && list.length === 0 && <p className="bb-ok">Every book has an EPUB.</p>}
        <ul className="bb-lib-convert">
          {list.map((b) => {
            const src = b.files.find((f) => ["azw3", "mobi", "fb2", "txt"].includes(f.format));
            return (
              <li key={b.id}>
                <input
                  type="checkbox"
                  aria-label={`Select ${b.title}`}
                  checked={selected.has(b.id)}
                  onChange={() =>
                    setSelected((s) => {
                      const n = new Set(s);
                      n.has(b.id) ? n.delete(b.id) : n.add(b.id);
                      return n;
                    })
                  }
                />
                <Cover src={librarianApi.coverUrl(b)} title={b.title} size={32} />
                <div>
                  <strong>{b.title}</strong>
                  <div className="bb-muted bb-small">{b.authors.join(", ") || "No author"}</div>
                </div>
                {src && (
                  <span className="bb-small">
                    <b>{src.format.toUpperCase()}</b> → EPUB <span className="bb-muted">· {formatBytes(src.sizeBytes)}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card
        title="Kobo"
        actions={
          <button className="bb-btn bb-btn-small" disabled={act.busy || !t?.kepubify} onClick={() => act.run(async () => (await librarianApi.prepareKobo(), setNotice("Preparing every EPUB for Kobo."), tools.reload()))}>
            Prepare every EPUB for Kobo
          </button>
        }
      >
        <p className="bb-muted">
          Kobo e-readers read KEPUB best. Bookbandit makes a KEPUB copy of each EPUB ({t?.epubBooks ?? "…"} books) in its cache, so
          a Kobo sync never waits. Your files aren't changed.
        </p>
      </Card>

      <Card title="Write details into EPUB files">
        <label className="bb-field bb-field-inline">
          <input
            type="checkbox"
            checked={t?.settings.writeMetadata ?? false}
            disabled={!t || act.busy}
            onChange={(e) => {
              const on = e.target.checked;
              act.run(async () => {
                const s = await librarianApi.setWriteMetadata(on);
                tools.setData((d) => (d ? { ...d, settings: s } : d));
              });
            }}
          />
          After a bulk edit, write the title, authors, series, language and ISBN into the book's EPUB files
        </label>
        <p className="bb-muted bb-small">
          Off by default. Useful when other apps read the same folder (Calibre, a Kobo over USB). Bookbandit never writes into
          DRM-protected files, PDFs or comics.
        </p>
      </Card>

      {t && t.jobs.length > 0 && (
        <Card title="Recent work">
          <ul className="bb-lib-jobs">
            {t.jobs.map((j) => (
              <li key={j.id} className={`is-${j.status}`}>
                <span className={`bb-status${j.status === "done" ? " is-on" : ""}`}>{STATUS[j.status]}</span>
                <div>
                  <span>{j.label ?? j.type}</span>
                  {j.lastError && j.status === "failed" ? <div className="bb-muted bb-small">{j.lastError}</div> : null}
                  {j.status === "running" ? <Bar value={j.progress ?? 0} /> : null}
                </div>
                <span className="bb-muted bb-small">{timeAgo(j.finishedAt ?? j.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

const STATUS: Record<string, string> = { queued: "Waiting", running: "Working", done: "Done", failed: "Failed", cancelled: "Cancelled" };
