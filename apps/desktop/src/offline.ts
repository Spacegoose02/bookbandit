/**
 * Offline library and reader: books saved on this PC (Offline > Save this book for offline).
 * Only the books saved by the person who was signed in last are listed (the native side filters
 * them), and reading positions go back to the server on the next sync.
 */
import "./styles.css";
import type { FoliateLocation, FoliateView } from "foliate-js/view.js";
import { errorText, native, type Library, type OfflineBook } from "./bridge";
import { esc, mimeFor, percentLabel, sizeLabel } from "./format";

const app = document.getElementById("app")!;
const FACE = "/brand/barnaby-face.webp";
const FULL = "/brand/barnaby-full.webp";
const coverUrls = new Map<string, string>();

function toast(text: string): void {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

async function coverFor(b: OfflineBook): Promise<string | null> {
  if (!b.hasCover) return null;
  const hit = coverUrls.get(b.bookId);
  if (hit) return hit;
  try {
    const bytes = await native.cover(b.bookId);
    const head = new Uint8Array(bytes.slice(0, 5));
    const svg = String.fromCharCode(...head) === "<svg ";
    const url = URL.createObjectURL(new Blob([bytes], svg ? { type: "image/svg+xml" } : {}));
    coverUrls.set(b.bookId, url);
    return url;
  } catch {
    return null;
  }
}

// --- library ------------------------------------------------------------------

async function showLibrary(): Promise<void> {
  document.title = "BookBandit: offline library";
  let lib: Library;
  try {
    lib = await native.library();
  } catch (e) {
    app.innerHTML = `<p class="error">${esc(errorText(e))}</p>`;
    return;
  }
  const online = await native.serverReachable().catch(() => false);
  const who = lib.user ? `${esc(lib.user.displayName)}'s` : "Your";

  app.innerHTML = `
    <header class="topbar">
      <span class="logo"><img src="${FACE}" alt="" /><span>Book<b>Bandit</b></span></span>
      <span class="spacer"></span>
      <button class="btn" id="sync" ${online ? "" : "hidden"}>Sync now</button>
      <button class="btn primary" id="back">${online ? "Back to the library" : "Try the library"}</button>
    </header>
    <div class="banner ${online ? "online" : ""}">
      <span class="dot" aria-hidden="true"></span>
      <p>${
        online
          ? "You're online. Reading progress from this PC syncs automatically."
          : "You're offline. Read anything saved here; your place syncs when you're back online."
      }${lib.pending ? ` <span class="muted">(${lib.pending} reading ${lib.pending === 1 ? "position" : "positions"} waiting to sync)</span>` : ""}</p>
    </div>
    <main class="page" id="list"></main>
  `;
  document.getElementById("back")!.addEventListener("click", async () => {
    if (await native.serverReachable().catch(() => false)) await native.openServer().catch((e) => toast(errorText(e)));
    else toast("Still can't reach the server. Your saved books are right here.");
  });
  document.getElementById("sync")!.addEventListener("click", async () => {
    try {
      const r = await native.sync();
      toast(r.signedIn ? `Synced ${r.uploaded} reading ${r.uploaded === 1 ? "position" : "positions"}` : "Sign in first, then sync");
      void showLibrary();
    } catch (e) {
      toast(errorText(e));
    }
  });

  const list = document.getElementById("list")!;
  if (!lib.user || lib.books.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <img src="${FULL}" alt="" />
        <h2>No books saved on this PC yet</h2>
        <p>Open a book in the library and choose <b>Offline &gt; Save this book for offline</b> (or press <kbd>Ctrl</kbd> <kbd>S</kbd>).
        It'll be here next time you're without internet.</p>
      </div>`;
    return;
  }

  const total = lib.books.reduce((n, b) => n + b.sizeBytes, 0);
  list.innerHTML = `
    <h2>${who} books on this PC</h2>
    <p class="sub">${lib.books.length} ${lib.books.length === 1 ? "book" : "books"} · ${sizeLabel(total)}</p>
    <div class="grid">${lib.books
      .map((b) => {
        const pct = b.progress?.percent ?? 0;
        return `
        <article class="book" data-id="${esc(b.bookId)}">
          <button class="open" aria-label="Read ${esc(b.title)}">
            <span class="cover" data-cover="${esc(b.bookId)}">${esc(b.title)}</span>
            <span class="title">${esc(b.title)}</span>
            ${b.authors.length ? `<span class="by">${esc(b.authors.join(", "))}</span>` : ""}
          </button>
          <div class="bar" aria-hidden="true"><i style="width:${Math.round(pct * 100)}%"></i></div>
          <div class="meta"><span>${percentLabel(pct)}</span><button class="remove">Remove</button></div>
        </article>`;
      })
      .join("")}</div>`;

  for (const b of lib.books) {
    void coverFor(b).then((url) => {
      const slot = list.querySelector<HTMLElement>(`[data-cover="${CSS.escape(b.bookId)}"]`);
      if (url && slot) slot.outerHTML = `<img class="cover" src="${url}" alt="" />`;
    });
  }
  list.querySelectorAll<HTMLElement>(".book").forEach((el) => {
    const b = lib.books.find((x) => x.bookId === el.dataset.id)!;
    el.querySelector(".open")!.addEventListener("click", () => {
      location.hash = `read/${encodeURIComponent(b.bookId)}`;
    });
    el.querySelector(".remove")!.addEventListener("click", async () => {
      await native.remove(b.bookId).catch((e) => toast(errorText(e)));
      toast(`Removed "${b.title}" from this PC`);
      void showLibrary();
    });
  });
}

// --- reader -------------------------------------------------------------------

let closeReader: (() => void) | null = null;

async function showReader(bookId: string): Promise<void> {
  const lib = await native.library();
  const book = lib.books.find((b) => b.bookId === bookId);
  if (!book) {
    location.hash = "";
    return;
  }
  document.title = `${book.title} · BookBandit`;
  app.innerHTML = `
    <div class="reader">
      <header class="topbar">
        <button class="btn" id="close">← Library</button>
        <span class="rtitle">${esc(book.title)}</span>
        <span class="muted" id="where"></span>
      </header>
      <div class="stage" id="stage">
        <button class="turn prev" id="prev" aria-label="Previous page">‹</button>
        <button class="turn next" id="next" aria-label="Next page">›</button>
      </div>
      <footer class="status"><span id="chapter"></span><span id="pct">${percentLabel(book.progress?.percent)}</span></footer>
    </div>`;
  document.getElementById("close")!.addEventListener("click", () => (location.hash = ""));
  const stage = document.getElementById("stage")!;

  let bytes: ArrayBuffer;
  try {
    bytes = await native.file(book.bookId);
  } catch (e) {
    stage.innerHTML = `<div class="empty"><img src="${FULL}" alt="" /><h2>Couldn't open this book</h2><p>${esc(errorText(e))}</p></div>`;
    return;
  }
  const file = new File([bytes], book.fileName, { type: mimeFor(book.format) });

  if (book.format === "pdf") {
    // The Windows web view has a built-in PDF viewer; positions in PDFs stay on this PC for now.
    const url = URL.createObjectURL(file);
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.title = book.title;
    stage.replaceChildren(frame);
    closeReader = () => URL.revokeObjectURL(url);
    return;
  }

  await import("foliate-js/view.js");
  const view = document.createElement("foliate-view") as FoliateView;
  stage.append(view);

  let pending: { loc: FoliateLocation } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    if (!pending?.loc.cfi) return;
    const { loc } = pending;
    pending = null;
    const percent = loc.fraction ?? 0;
    void native.saveProgress(book.bookId, { kind: "epub", cfi: loc.cfi, percent }, percent, percent >= 0.995).catch(() => undefined);
  };

  view.addEventListener("relocate", (e) => {
    const loc = (e as CustomEvent<FoliateLocation>).detail;
    document.getElementById("pct")!.textContent = percentLabel(loc.fraction);
    document.getElementById("chapter")!.textContent = loc.tocItem?.label ?? "";
    pending = { loc };
    clearTimeout(timer);
    timer = setTimeout(flush, 1500);
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "PageUp") void view.goLeft();
    else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") void view.goRight();
    else if (e.key === "Escape") location.hash = "";
  };
  view.addEventListener("load", (e) => (e as CustomEvent<{ doc: Document }>).detail.doc.addEventListener("keydown", onKey));
  document.addEventListener("keydown", onKey);
  document.getElementById("prev")!.addEventListener("click", () => void view.goLeft());
  document.getElementById("next")!.addEventListener("click", () => void view.goRight());
  window.addEventListener("pagehide", flush);

  closeReader = () => {
    flush();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("pagehide", flush);
    view.close();
  };

  try {
    await view.open(file);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    view.renderer.setStyles?.(
      `html { color-scheme: ${dark ? "dark" : "light"}; } body { background: transparent !important; color: ${dark ? "#dcdfe5" : "#2a241b"} !important; line-height: 1.6; } a { color: ${dark ? "#f0b866" : "#a8641c"}; }`,
    );
    view.renderer.setAttribute("gap", "6%");
    view.renderer.setAttribute("margin", "48px");
    view.renderer.setAttribute("max-inline-size", "720px");
    view.renderer.setAttribute("max-column-count", "2");
    const cfi = book.progress?.locator.kind === "epub" && book.progress.locator.cfi ? book.progress.locator.cfi : null;
    await view.init({ lastLocation: cfi, showTextStart: !cfi });
    if (cfi && book.progress?.deviceName) toast(`Picked up where you left off on ${book.progress.deviceName}`);
  } catch (e) {
    stage.innerHTML = `<div class="empty"><img src="${FULL}" alt="" /><h2>Couldn't open this book</h2><p>${esc(errorText(e))}</p></div>`;
  }
}

function route(): void {
  closeReader?.();
  closeReader = null;
  const m = /^#read\/(.+)$/.exec(location.hash);
  if (m) void showReader(decodeURIComponent(m[1]!));
  else void showLibrary();
}

window.addEventListener("hashchange", route);
route();
