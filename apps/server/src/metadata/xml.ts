import { XMLParser } from "fast-xml-parser";

/** Parser that drops namespace prefixes (dc:title → title) and keeps attributes under "@_". */
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
});

/** Parse untrusted XML. DOCTYPE blocks are removed first so custom entities never expand. */
export function parseXml(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^\uFEFF/, "").replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, "");
  return xml.parse(cleaned) as Record<string, unknown>;
}

export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Text content of a node that may be a string, a number or { "#text": ... }. */
export function textOf(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as object)) return textOf((v as { "#text": unknown })["#text"]);
  return undefined;
}

export function attrOf(v: unknown, name: string): string | undefined {
  if (v && typeof v === "object") {
    const a = (v as Record<string, unknown>)[`@_${name}`];
    return typeof a === "string" ? a : undefined;
  }
  return undefined;
}
