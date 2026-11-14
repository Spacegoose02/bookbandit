/**
 * Reading fonts bundled with the app, so "Easy-read sans" (Atkinson Hyperlegible) and
 * "Dyslexia-friendly" (OpenDyslexic) work offline and on tablets that don't have them.
 * Both fonts are under the SIL Open Font License.
 *
 * The reader's book pages live in an iframe, so `fontFaceCss()` uses absolute URLs and is
 * injected into each page by `readerCss()` as well as into the app itself.
 */
import atkinson400 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2?url";
import atkinson700 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2?url";
import dyslexic400 from "@fontsource/opendyslexic/files/opendyslexic-latin-400-normal.woff2?url";
import dyslexic700 from "@fontsource/opendyslexic/files/opendyslexic-latin-700-normal.woff2?url";

const FACES: [family: string, weight: number, url: string][] = [
  ["Atkinson Hyperlegible", 400, atkinson400],
  ["Atkinson Hyperlegible", 700, atkinson700],
  ["OpenDyslexic", 400, dyslexic400],
  ["OpenDyslexic", 700, dyslexic700],
];

function absolute(url: string): string {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

/** `@font-face` rules for the bundled reading fonts. */
export function fontFaceCss(): string {
  return FACES.map(
    ([family, weight, url]) =>
      `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url("${absolute(url)}") format("woff2");}`,
  ).join("\n");
}

/** Make the fonts available to the app's own pages (settings previews, high-contrast theme). */
export function installAppFonts(doc: Document = document): void {
  if (doc.getElementById("bb-reading-fonts")) return;
  const style = doc.createElement("style");
  style.id = "bb-reading-fonts";
  style.textContent = fontFaceCss();
  doc.head.appendChild(style);
}
