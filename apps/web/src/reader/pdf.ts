/**
 * PDF reading with pdf.js: one page at a time on a canvas, fitted to the stage.
 * Position is a page locator ({ kind: "page", page, totalPages }), 0-based page,
 * so it syncs through the same progress API as reflowable books.
 */
import type { ReadingLocator } from "@bookbandit/shared";

export interface PdfPosition {
  /** 0-based */
  page: number;
  total: number;
}

export function clampPage(page: number, total: number): number {
  if (total <= 0 || !Number.isFinite(page)) return 0;
  return Math.min(total - 1, Math.max(0, Math.floor(page)));
}

export function pageLocator(pos: PdfPosition): Extract<ReadingLocator, { kind: "page" }> {
  return { kind: "page", page: pos.page, totalPages: pos.total };
}

/** Where to start from a saved locator. Page locators win; a percent from elsewhere maps to a page. */
export function startPage(locator: ReadingLocator | null | undefined, total: number): number {
  if (!locator || total <= 0) return 0;
  if (locator.kind === "page") {
    // If the file changed length, keep the same relative spot.
    if (locator.totalPages > 0 && locator.totalPages !== total)
      return clampPage(Math.round((locator.page / locator.totalPages) * total), total);
    return clampPage(locator.page, total);
  }
  if (locator.kind === "epub") return clampPage(Math.round(locator.percent * (total - 1)), total);
  return 0;
}

export function fraction(pos: PdfPosition): number {
  return pos.total > 1 ? pos.page / (pos.total - 1) : pos.total === 1 ? 1 : 0;
}

type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

export class PdfView {
  private doc: PdfDoc | null = null;
  private canvas = document.createElement("canvas");
  private renderTask: { cancel(): void; promise: Promise<unknown> } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  page = 0;

  constructor(
    private host: HTMLElement,
    private onRelocate: (pos: PdfPosition) => void,
  ) {
    this.canvas.className = "bb-pdf-canvas";
    host.replaceChildren(this.canvas);
  }

  get total(): number {
    return this.doc?.numPages ?? 0;
  }

  async open(url: string): Promise<void> {
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    // Same-origin request, so the session cookie or proxy auth comes along.
    this.doc = await pdfjs.getDocument({ url, withCredentials: true }).promise;
    this.resizeObserver = new ResizeObserver(() => void this.render());
    this.resizeObserver.observe(this.host);
  }

  async goTo(page: number): Promise<void> {
    if (!this.doc) return;
    this.page = clampPage(page, this.total);
    await this.render();
    this.onRelocate({ page: this.page, total: this.total });
  }

  next = () => void this.goTo(this.page + 1);
  prev = () => void this.goTo(this.page - 1);

  private async render(): Promise<void> {
    if (!this.doc) return;
    const pdfPage = await this.doc.getPage(this.page + 1);
    const base = pdfPage.getViewport({ scale: 1 });
    const { clientWidth: w, clientHeight: h } = this.host;
    const scale = Math.max(0.1, Math.min(w / base.width, h / base.height));
    const dpr = window.devicePixelRatio || 1;
    const viewport = pdfPage.getViewport({ scale: scale * dpr });
    this.renderTask?.cancel();
    this.canvas.width = Math.floor(viewport.width);
    this.canvas.height = Math.floor(viewport.height);
    this.canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    this.canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const task = pdfPage.render({ canvasContext: ctx, viewport });
    this.renderTask = task;
    try {
      await task.promise;
    } catch (e) {
      if ((e as { name?: string }).name !== "RenderingCancelledException") throw e;
    }
  }

  close(): void {
    this.resizeObserver?.disconnect();
    this.renderTask?.cancel();
    void this.doc?.destroy();
    this.doc = null;
  }
}
