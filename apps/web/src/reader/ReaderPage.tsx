import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { FoliateLocation, FoliateView } from "foliate-js/view.js";
import { api, ApiError } from "../api/client";
import type { Bookmark, BookDetail } from "../api/types";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import { ThemePicker } from "../themes/ThemePicker";
import { pickReadableFile } from "./formats";
import { fraction, pageLocator, PdfView, startPage, type PdfPosition } from "./pdf";
import { defaultDeviceName, ProgressSync, resolveStartPosition } from "./progressSync";
import { readerCss } from "./readerCss";
import { useReaderPrefs } from "./useReaderPrefs";

type Panel = null | "settings" | "bookmarks" | "contents";

function deviceName(): string {
  try {
    return localStorage.getItem("bb-device-name") || defaultDeviceName();
  } catch {
    return defaultDeviceName();
  }
}

export function ReaderPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { me, theme } = useSession();
  const kid = !!me?.isKid;
  const [prefs, setPrefs] = useReaderPrefs(me?.id ?? "anon", kid);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const syncRef = useRef<ProgressSync | null>(null);

  const [book, setBook] = useState<BookDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "unsupported" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [loc, setLoc] = useState<FoliateLocation | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [chrome, setChrome] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const pdfRef = useRef<PdfView | null>(null);
  const [pdfPos, setPdfPos] = useState<PdfPosition | null>(null);
  const isPdf = pdfPos !== null || pdfRef.current !== null;

  // --- open the book -------------------------------------------------------
  useEffect(() => {
    if (!me) return;
    let disposed = false;
    const sync = new ProgressSync(api, id, { deviceName: deviceName(), store: localStorage });
    syncRef.current = sync;

    (async () => {
      let detail: BookDetail;
      try {
        detail = await api.book(id);
      } catch (e) {
        if ((e instanceof ApiError && e.notFound) || (e as { notFound?: boolean }).notFound) setStatus("missing");
        else {
          setErrorText(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
        return;
      }
      if (disposed) return;
      setBook(detail);
      const file = pickReadableFile(detail.files);
      if (!file) {
        setStatus("unsupported");
        return;
      }
      const url = api.fileUrl(detail.id, file.id);
      if (file.format === "pdf") {
        if (!hostRef.current) return;
        const pdf = new PdfView(hostRef.current, (pos) => {
          setPdfPos(pos);
          sync.report(pageLocator(pos), pos.page === pos.total - 1);
        });
        pdfRef.current = pdf;
        try {
          await pdf.open(url);
        } catch (e) {
          if (disposed) return;
          setErrorText(e instanceof Error ? e.message : String(e));
          setStatus("error");
          return;
        }
        if (disposed) return;
        const start = await resolveStartPosition(api, localStorage, id);
        if (disposed) return;
        await pdf.goTo(startPage(start?.locator, pdf.total));
        if (start && start.fromDevice && start.fromDevice !== deviceName())
          setToast(kid ? "Here's where you stopped!" : `Picked up where you left off on ${start.fromDevice}`);
        setStatus("ready");
        api.bookmarks(id).then((b) => !disposed && setBookmarks(b), () => undefined);
        return;
      }

      await import("foliate-js/view.js");
      if (disposed || !hostRef.current) return;
      const view = document.createElement("foliate-view") as FoliateView;
      view.className = "bb-foliate";
      hostRef.current.replaceChildren(view);
      viewRef.current = view;

      view.addEventListener("relocate", (e) => {
        const detail = (e as CustomEvent<FoliateLocation>).detail;
        setLoc(detail);
        if (detail.cfi) sync.report({ kind: "epub", cfi: detail.cfi, percent: detail.fraction ?? 0 }, detail.fraction >= 0.995);
      });
      view.addEventListener("load", (e) => {
        const doc = (e as CustomEvent<{ doc: Document }>).detail.doc;
        doc.addEventListener("keydown", onKey);
      });

      try {
        await view.open(url);
      } catch (e) {
        if (disposed) return;
        setErrorText(e instanceof Error ? e.message : String(e));
        setStatus("error");
        return;
      }
      if (disposed) return;
      applyLayoutRef.current(view);
      const start = await resolveStartPosition(api, localStorage, id);
      if (disposed) return;
      const cfi = start?.locator.kind === "epub" ? start.locator.cfi : null;
      await view.init({ lastLocation: cfi, showTextStart: !cfi });
      if (cfi && start?.fromDevice && start.fromDevice !== deviceName())
        setToast(kid ? "Here's where you stopped!" : `Picked up where you left off on ${start.fromDevice}`);
      setStatus("ready");
      api.bookmarks(id).then((b) => !disposed && setBookmarks(b), () => undefined);
    })();

    const onHide = () => {
      if (document.visibilityState === "hidden") void sync.flush({ keepalive: true });
    };
    const onPageHide = () => void sync.flush({ keepalive: true });
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      void sync.flush({ keepalive: true });
      sync.dispose();
      viewRef.current?.close();
      viewRef.current?.remove();
      viewRef.current = null;
      pdfRef.current?.close();
      pdfRef.current = null;
      setPdfPos(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, me?.id]);

  // --- styles follow theme and text settings --------------------------------
  const applyLayout = useCallback(
    (view: FoliateView | null = viewRef.current) => {
      if (!view?.renderer) return;
      view.renderer.setStyles?.(readerCss(theme, prefs));
      view.renderer.setAttribute("flow", prefs.flow);
      view.renderer.setAttribute("gap", "6%");
      view.renderer.setAttribute("margin", kid ? "56px" : "48px");
      view.renderer.setAttribute("max-inline-size", kid ? "900px" : "720px");
      view.renderer.setAttribute("max-column-count", kid ? "1" : "2");
    },
    [theme, prefs, kid],
  );
  const applyLayoutRef = useRef(applyLayout);
  applyLayoutRef.current = applyLayout;
  useEffect(() => applyLayout(), [applyLayout]);

  // --- navigation ------------------------------------------------------------
  const prev = useCallback(() => (pdfRef.current ? pdfRef.current.prev() : void viewRef.current?.goLeft()), []);
  const next = useCallback(() => (pdfRef.current ? pdfRef.current.next() : void viewRef.current?.goRight()), []);
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "PageUp") prev();
      else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") next();
      else if (e.key === "Escape") setPanel(null);
    },
    [prev, next],
  );
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onKey]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- bookmarks -------------------------------------------------------------
  const here = pdfPos
    ? bookmarks.find((b) => b.locator.kind === "page" && b.locator.page === pdfPos.page)
    : loc?.cfi
      ? bookmarks.find((b) => b.locator.kind === "epub" && b.locator.cfi === loc.cfi)
      : undefined;
  const toggleBookmark = async () => {
    if (!pdfPos && !loc?.cfi) return;
    if (here) {
      setBookmarks((bs) => bs.filter((b) => b.id !== here.id));
      await api.deleteBookmark(here.id).catch(() => setBookmarks((bs) => [...bs, here]));
      return;
    }
    try {
      const b = await api.addBookmark({
        bookId: id,
        kind: "bookmark",
        locator: pdfPos ? pageLocator(pdfPos) : { kind: "epub", cfi: loc!.cfi!, percent: loc!.fraction },
        text: pdfPos ? `Page ${pdfPos.page + 1}` : (loc?.tocItem?.label ?? null),
        note: null,
        color: null,
      });
      setBookmarks((bs) => [...bs, b]);
      setToast(kid ? "Saved your page! ⭐" : "Bookmark added");
    } catch {
      setToast("Couldn't save the bookmark");
    }
  };

  // --- render ----------------------------------------------------------------
  if (status === "missing")
    return (
      <BarnabyEmpty title="Barnaby can't find that book">
        <Link className="bb-btn" to="/">
          Back to books
        </Link>
      </BarnabyEmpty>
    );
  if (status === "unsupported")
    return (
      <BarnabyEmpty title="This one can't open in the reader yet">
        <Link className="bb-btn" to={`/book/${id}`}>
          Back
        </Link>
      </BarnabyEmpty>
    );
  if (status === "error")
    return (
      <BarnabyEmpty title="Something went wrong opening this book">
        <p className="bb-muted">{errorText}</p>
        <Link className="bb-btn" to={`/book/${id}`}>
          Back
        </Link>
      </BarnabyEmpty>
    );

  const frac = pdfPos ? fraction(pdfPos) : (loc?.fraction ?? 0);
  const pct = Math.round(frac * 100);

  return (
    <div className={`bb-reader${kid ? " is-kid" : ""}${chrome ? "" : " is-immersive"}`}>
      <header className="bb-reader-bar">
        <button className="bb-icon-btn" onClick={() => navigate(kid ? "/" : `/book/${id}`)} aria-label="Close book">
          {kid ? "🏠" : "←"}
        </button>
        <div className="bb-reader-title">
          <strong>{book?.title ?? ""}</strong>
          {!kid && loc?.tocItem?.label && <span className="bb-muted">{loc.tocItem.label}</span>}
        </div>
        {!kid && !pdfPos && (
          <button className="bb-icon-btn" aria-label="Contents" aria-pressed={panel === "contents"} onClick={() => setPanel(panel === "contents" ? null : "contents")}>
            ☰
          </button>
        )}
        <button className="bb-icon-btn" aria-label={here ? "Remove bookmark" : "Bookmark this page"} aria-pressed={!!here} onClick={toggleBookmark}>
          {kid ? (here ? "⭐" : "☆") : here ? "🔖" : "📑"}
        </button>
        {!kid && (
          <button className="bb-icon-btn" aria-label="Bookmarks" aria-pressed={panel === "bookmarks"} onClick={() => setPanel(panel === "bookmarks" ? null : "bookmarks")}>
            ★
          </button>
        )}
        <button className="bb-icon-btn" aria-label="Text and colors" aria-pressed={panel === "settings"} onClick={() => setPanel(panel === "settings" ? null : "settings")}>
          Aa
        </button>
      </header>

      <div className="bb-reader-stage">
        <div ref={hostRef} className={isPdf ? "bb-pdf-host" : "bb-reader-host"} />
        {status === "loading" && <div className="bb-reader-loading">Opening book…</div>}
        <button className="bb-turn bb-turn-prev" onClick={prev} aria-label="Previous page">
          <span aria-hidden>‹</span>
        </button>
        <button className="bb-turn bb-turn-next" onClick={next} aria-label="Next page">
          <span aria-hidden>›</span>
        </button>
        <button className="bb-immersive-toggle" onClick={() => setChrome((c) => !c)} aria-label={chrome ? "Hide toolbar" : "Show toolbar"} />
      </div>

      <footer className="bb-reader-foot">
          {kid ? (
            <div className="bb-kid-progress" aria-label={`${pct}% of the book`}>
              <span style={{ width: `${pct}%` }} />
              <img src={`${import.meta.env.BASE_URL}brand/barnaby-face.webp`} alt="" style={{ left: `${pct}%` }} />
            </div>
          ) : (
            <>
              <input
                className="bb-slider"
                type="range"
                min={0}
                max={1000}
                value={Math.round(frac * 1000)}
                aria-label="Position in book"
                onChange={(e) => {
                  const f = Number(e.target.value) / 1000;
                  if (pdfRef.current) void pdfRef.current.goTo(Math.round(f * (pdfRef.current.total - 1)));
                  else void viewRef.current?.goToFraction(f);
                }}
              />
              <span className="bb-muted bb-small">
                {pdfPos
                  ? `Page ${pdfPos.page + 1} of ${pdfPos.total}`
                  : `${pct}%${loc?.location ? ` · loc ${loc.location.current + 1} of ${loc.location.total}` : ""}`}
              </span>
            </>
          )}
      </footer>

      {panel && (
        <aside className="bb-panel" role="dialog" aria-label={panel}>
          <button className="bb-panel-close bb-icon-btn" onClick={() => setPanel(null)} aria-label="Close">
            ✕
          </button>
          {panel === "settings" && (
            <div className="bb-panel-body">
              <h2>Text</h2>
              <div className="bb-stepper">
                <button className="bb-btn bb-btn-big" onClick={() => setPrefs({ fontSize: prefs.fontSize - 10 })} aria-label="Smaller text">
                  A−
                </button>
                <span>{prefs.fontSize}%</span>
                <button className="bb-btn bb-btn-big" onClick={() => setPrefs({ fontSize: prefs.fontSize + 10 })} aria-label="Bigger text">
                  A+
                </button>
              </div>
              {!kid && (
                <>
                  <label className="bb-field">
                    <span>Font</span>
                    <select className="bb-input" value={prefs.fontFamily} onChange={(e) => setPrefs({ fontFamily: e.target.value as typeof prefs.fontFamily })}>
                      <option value="book">Book's own</option>
                      <option value="serif">Serif</option>
                      <option value="sans">Easy-read sans</option>
                      <option value="dyslexic">Dyslexia-friendly</option>
                    </select>
                  </label>
                  <label className="bb-field">
                    <span>Line spacing</span>
                    <input type="range" min={1} max={2.4} step={0.1} value={prefs.lineHeight} onChange={(e) => setPrefs({ lineHeight: Number(e.target.value) })} />
                  </label>
                  <label className="bb-field bb-field-inline">
                    <input type="checkbox" checked={prefs.flow === "scrolled"} onChange={(e) => setPrefs({ flow: e.target.checked ? "scrolled" : "paginated" })} />
                    <span>Scroll instead of turning pages</span>
                  </label>
                </>
              )}
              <h2>Colors</h2>
              <ThemePicker compact />
            </div>
          )}
          {panel === "bookmarks" && (
            <div className="bb-panel-body">
              <h2>Bookmarks</h2>
              {bookmarks.length === 0 && <p className="bb-muted">No bookmarks yet. Tap 📑 to mark a page.</p>}
              <ul className="bb-list">
                {[...bookmarks]
                  .sort((a, b) => sortKey(a.locator) - sortKey(b.locator))
                  .map((b) => (
                    <li key={b.id}>
                      <button
                        className="bb-list-btn"
                        onClick={() => {
                          if (b.locator.kind === "epub") void viewRef.current?.goTo(b.locator.cfi);
                          else if (b.locator.kind === "page") void pdfRef.current?.goTo(b.locator.page);
                          setPanel(null);
                        }}
                      >
                        <strong>{b.text ?? "Bookmark"}</strong>
                        <span className="bb-muted">
                          {b.locator.kind === "epub" ? `${Math.round(b.locator.percent * 100)}%` : b.locator.kind === "page" ? `p. ${b.locator.page + 1}` : ""}
                        </span>
                      </button>
                      <button
                        className="bb-icon-btn"
                        aria-label="Delete bookmark"
                        onClick={() => {
                          setBookmarks((bs) => bs.filter((x) => x.id !== b.id));
                          void api.deleteBookmark(b.id);
                        }}
                      >
                        🗑
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {panel === "contents" && (
            <div className="bb-panel-body">
              <h2>Contents</h2>
              <Toc
                items={viewRef.current?.book?.toc ?? []}
                current={loc?.tocItem?.href}
                onPick={(href) => {
                  void viewRef.current?.goTo(href);
                  setPanel(null);
                }}
              />
            </div>
          )}
        </aside>
      )}

      {toast && (
        <div className="bb-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function sortKey(l: Bookmark["locator"]): number {
  if (l.kind === "epub") return l.percent;
  if (l.kind === "page") return l.totalPages > 0 ? l.page / l.totalPages : l.page;
  return 0;
}

function Toc({
  items,
  current,
  onPick,
}: {
  items: { label: string; href: string; subitems?: { label: string; href: string }[] }[];
  current?: string;
  onPick(href: string): void;
}) {
  if (!items.length) return <p className="bb-muted">This book has no table of contents.</p>;
  return (
    <ul className="bb-list bb-toc">
      {items.map((t) => (
        <li key={t.href}>
          <button className="bb-list-btn" aria-current={t.href === current ? "true" : undefined} onClick={() => onPick(t.href)}>
            {t.label}
          </button>
          {t.subitems?.length ? <Toc items={t.subitems} current={current} onPick={onPick} /> : null}
        </li>
      ))}
    </ul>
  );
}
