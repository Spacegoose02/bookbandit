/** Minimal types for the parts of foliate-js we use. The library ships plain JS. */
declare module "foliate-js/view.js" {
  export interface FoliateTocItem {
    label: string;
    href: string;
    subitems?: FoliateTocItem[];
  }
  export interface FoliateLocation {
    fraction: number;
    cfi: string;
    location?: { current: number; next: number; total: number };
    section?: { current: number; total: number };
    tocItem?: { label?: string; href?: string } | null;
    pageItem?: { label?: string } | null;
  }
  export interface FoliateRenderer extends HTMLElement {
    setStyles(css: string | [string, string]): void;
    next(): Promise<void>;
    prev(): Promise<void>;
  }
  export interface FoliateView extends HTMLElement {
    book: { metadata?: { title?: string }; toc?: FoliateTocItem[]; dir?: string } | null;
    renderer: FoliateRenderer;
    lastLocation: FoliateLocation | null;
    open(book: string | Blob | File): Promise<void>;
    init(opts: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>;
    close(): void;
    goTo(target: string | number): Promise<void>;
    goToFraction(fraction: number): Promise<void>;
    next(): Promise<void>;
    prev(): Promise<void>;
    goLeft(): Promise<void>;
    goRight(): Promise<void>;
    addAnnotation(a: { value: string; color?: string }, remove?: boolean): Promise<unknown>;
  }
  export class View extends HTMLElement {}
}
