import { fontFaceCss } from "../themes/fonts";
import type { Theme } from "../themes/themes";

export interface ReaderPrefs {
  /** Percent, 100 = book default */
  fontSize: number;
  lineHeight: number;
  fontFamily: "book" | "serif" | "sans" | "dyslexic";
  flow: "paginated" | "scrolled";
}

export const DEFAULT_PREFS: ReaderPrefs = { fontSize: 110, lineHeight: 1.5, fontFamily: "book", flow: "paginated" };
/** Kids get big, friendly text by default. */
export const KID_PREFS: ReaderPrefs = { fontSize: 150, lineHeight: 1.7, fontFamily: "sans", flow: "paginated" };

const FONTS: Record<ReaderPrefs["fontFamily"], string | null> = {
  book: null,
  serif: `Georgia, "Iowan Old Style", "Palatino Linotype", serif`,
  sans: `"Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
  dyslexic: `"OpenDyslexic", "Comic Neue", "Comic Sans MS", sans-serif`,
};

export function clampPrefs(p: Partial<ReaderPrefs>, base: ReaderPrefs = DEFAULT_PREFS): ReaderPrefs {
  const fontSize = Math.min(250, Math.max(70, Math.round(p.fontSize ?? base.fontSize)));
  const lineHeight = Math.min(2.4, Math.max(1, p.lineHeight ?? base.lineHeight));
  const fontFamily = p.fontFamily && p.fontFamily in FONTS ? p.fontFamily : base.fontFamily;
  const flow = p.flow === "scrolled" || p.flow === "paginated" ? p.flow : base.flow;
  return { fontSize, lineHeight, fontFamily, flow };
}

/** CSS injected into each book page so it follows the app theme and the reader's text settings. */
export function readerCss(theme: Theme, prefs: ReaderPrefs): string {
  const c = theme.colors;
  const font = FONTS[prefs.fontFamily];
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    ${fontFaceCss() /* ws/kids: bundled reading fonts (themes/fonts.ts) */}
    html {
      color-scheme: ${theme.scheme};
      color: ${c.readerText};
      background: ${c.readerBg};
      font-size: ${prefs.fontSize}%;
    }
    html, body { background: ${c.readerBg} !important; }
    body { color: ${c.readerText} !important; }
    p, li, blockquote, dd, div, span {
      line-height: ${prefs.lineHeight} !important;
      ${font ? `font-family: ${font} !important;` : ""}
    }
    p, li, blockquote, dd { color: inherit !important; }
    h1, h2, h3, h4, h5, h6 { color: inherit !important; ${font ? `font-family: ${font} !important;` : ""} }
    a:any-link { color: ${c.readerLink} !important; }
    img, svg, video { max-width: 100%; height: auto; }
    ${theme.scheme === "dark" ? "img { filter: brightness(.92); }" : ""}
    aside[epub|type~="footnote"] { display: none; }
  `;
}
