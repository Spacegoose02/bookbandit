import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { FoliateLocation, FoliateTocItem, FoliateView } from "foliate-js/view.js";
import { api, ApiError } from "../api/client";
import type { BookDetail } from "../api/types";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import { pickReadableFile } from "../reader/formats";
import { defaultDeviceName, ProgressSync, resolveStartPosition } from "../reader/progressSync";
import { readerCss, type ReaderPrefs } from "../reader/readerCss";
import { flattenRecipes, type Recipe } from "./recipes";
import { useWakeLock } from "./useWakeLock";
import "./discover.css";

const SIZE_KEY = "bb-cook-size";
const SIZES = [130, 150, 175, 200, 230];

function savedSize(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return SIZES.includes(n) ? n : 150;
  } catch {
    return 150;
  }
}

/**
 * Cook mode: a cookbook opened for the kitchen. The screen stays awake, the text is big and
 * scrolls instead of turning pages, and the recipe list is always one tap away.
 */
export function CookbookPage() {
  const { id = "" } = useParams();
  const { theme } = useSession();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const [book, setBook] = useState<BookDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "unsupported" | "error">("loading");
  const [toc, setToc] = useState<FoliateTocItem[]>([]);
  const [current, setCurrent] = useState<string | undefined>();
  const [size, setSize] = useState(savedSize);
  const [filter, setFilter] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const awake = useWakeLock(status === "ready");

  const prefs: ReaderPrefs = useMemo(() => ({ fontSize: size, lineHeight: 1.7, fontFamily: "sans", flow: "scrolled" }), [size]);
  const apply = useCallback(
    (view: FoliateView | null = viewRef.current) => {
      if (!view?.renderer) return;
      view.renderer.setStyles?.(readerCss(theme, prefs));
      view.renderer.setAttribute("flow", "scrolled");
      view.renderer.setAttribute("margin", "32px");
      view.renderer.setAttribute("max-inline-size", "980px");
      view.renderer.setAttribute("max-column-count", "1");
    },
    [theme, prefs],
  );
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => apply(), [apply]);

  useEffect(() => {
    let disposed = false;
    const device = (() => {
      try {
        return localStorage.getItem("bb-device-name") || defaultDeviceName();
      } catch {
        return defaultDeviceName();
      }
    })();
    const sync = new ProgressSync(api, id, { deviceName: device, store: localStorage });

    (async () => {
      let detail: BookDetail;
      try {
        detail = await api.book(id);
      } catch (e) {
        setStatus((e instanceof ApiError && e.notFound) || (e as { notFound?: boolean }).notFound ? "missing" : "error");
        return;
      }
      if (disposed) return;
      setBook(detail);
      const file = pickReadableFile(detail.files);
      if (!file || file.format === "pdf") {
        setStatus("unsupported");
        return;
      }
      await import("foliate-js/view.js");
      if (disposed || !hostRef.current) return;
      const view = document.createElement("foliate-view") as FoliateView;
      view.className = "bb-foliate";
      hostRef.current.replaceChildren(view);
      viewRef.current = view;
      view.addEventListener("relocate", (e) => {
        const loc = (e as CustomEvent<FoliateLocation>).detail;
        setCurrent(loc.tocItem?.href ?? undefined);
        if (loc.cfi) sync.report({ kind: "epub", cfi: loc.cfi, percent: loc.fraction ?? 0 }, loc.fraction >= 0.995);
      });
      try {
        await view.open(api.fileUrl(detail.id, file.id));
      } catch {
        if (!disposed) setStatus("error");
        return;
      }
      if (disposed) return;
      applyRef.current(view);
      const start = await resolveStartPosition(api, localStorage, id);
      if (disposed) return;
      const cfi = start?.locator.kind === "epub" ? start.locator.cfi : null;
      await view.init({ lastLocation: cfi, showTextStart: !cfi });
      setToc(view.book?.toc ?? []);
      setStatus("ready");
    })();

    return () => {
      disposed = true;
      void sync.flush({ keepalive: true });
      sync.dispose();
      viewRef.current?.close();
      viewRef.current?.remove();
      viewRef.current = null;
    };
  }, [id]);

  const recipes = useMemo(() => flattenRecipes(toc), [toc]);
  const shown = recipes.filter((r) => r.label.toLowerCase().includes(filter.trim().toLowerCase()));

  const jump = (r: Recipe) => {
    void viewRef.current?.goTo(r.href);
    setListOpen(false);
  };
  const bump = (dir: 1 | -1) => {
    const i = SIZES.indexOf(size);
    const next = SIZES[Math.min(SIZES.length - 1, Math.max(0, i + dir))]!;
    setSize(next);
    try {
      localStorage.setItem(SIZE_KEY, String(next));
    } catch {
      /* ignore */
    }
  };

  if (status === "missing")
    return (
      <BarnabyEmpty title="Barnaby can't find that cookbook">
        <Link className="bb-btn" to="/">
          Back to books
        </Link>
      </BarnabyEmpty>
    );
  if (status === "unsupported" || status === "error")
    return (
      <BarnabyEmpty title={status === "error" ? "This cookbook didn't open" : "Cook mode needs an EPUB"}>
        <Link className="bb-btn" to={`/book/${id}`}>
          Back to the book
        </Link>
      </BarnabyEmpty>
    );

  return (
    <div className={`bb-cook${listOpen ? " is-list-open" : ""}`}>
      <header className="bb-cook-bar">
        <Link className="bb-icon-btn" to={`/book/${id}`} aria-label="Leave cook mode">
          ✕
        </Link>
        <div className="bb-cook-title">
          <strong>{book?.title ?? "Cookbook"}</strong>
          <span className={`bb-small ${awake ? "bb-cook-awake" : "bb-muted"}`}>
            {awake ? "☀ Screen stays on" : "Screen may sleep"}
          </span>
        </div>
        <button className="bb-btn bb-cook-recipes-btn" onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}>
          🍳 Recipes
        </button>
        <div className="bb-cook-size" role="group" aria-label="Text size">
          <button className="bb-btn" onClick={() => bump(-1)} aria-label="Smaller text" disabled={size === SIZES[0]}>
            A−
          </button>
          <button className="bb-btn" onClick={() => bump(1)} aria-label="Bigger text" disabled={size === SIZES[SIZES.length - 1]}>
            A+
          </button>
        </div>
      </header>
      <div className="bb-cook-body">
        <aside className="bb-cook-list" aria-label="Recipes">
          <input
            className="bb-input"
            type="search"
            placeholder="Find a recipe"
            aria-label="Find a recipe"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {status === "ready" && recipes.length === 0 && <p className="bb-muted bb-small">This book has no table of contents.</p>}
          <ul className="bb-list">
            {shown.map((r) => (
              <li key={r.href}>
                <button
                  className={`bb-list-btn bb-cook-item depth-${Math.min(r.depth, 2)}`}
                  aria-current={current === r.href ? "true" : undefined}
                  onClick={() => jump(r)}
                >
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <div className="bb-cook-stage">
          <div ref={hostRef} className="bb-reader-host" />
          {status === "loading" && <div className="bb-reader-loading">Opening cookbook…</div>}
        </div>
      </div>
    </div>
  );
}
