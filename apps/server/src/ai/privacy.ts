/**
 * Removes personal details from a kid's message before it reaches a model or the log:
 * e-mail addresses, phone numbers, street addresses, card-like numbers and links.
 * Parents see "[removed: phone]" in the log, not the value.
 */
export type PiiKind = "email" | "phone" | "address" | "number" | "link";

const RULES: { kind: PiiKind; pattern: RegExp }[] = [
  { kind: "email", pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { kind: "link", pattern: /\b(?:https?:\/\/|www\.)\S+/gi },
  { kind: "number", pattern: /\b(?:\d[ -]?){13,19}\b/g },
  { kind: "phone", pattern: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g },
  {
    kind: "address",
    pattern:
      /\b\d{1,6}\s+(?:[A-Z][a-z]+\s){1,3}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|boulevard|blvd|way|place|pl|terrace|close|crescent)\b\.?/gi,
  },
  { kind: "address", pattern: /\bi\s+live\s+(?:at|on)\s+[^.,!?\n]{3,60}/gi },
];

export function redactPersonalDetails(text: string): { text: string; removed: PiiKind[] } {
  const removed = new Set<PiiKind>();
  let out = text;
  for (const { kind, pattern } of RULES) {
    out = out.replace(pattern, () => {
      removed.add(kind);
      return `[removed: ${kind}]`;
    });
  }
  return { text: out, removed: [...removed] };
}

/** Links in a kid's answer are only allowed when they point at a cited source. */
export function stripUnlistedLinks(text: string, allowedUrls: string[]): string {
  const allowed = new Set(allowedUrls);
  return text.replace(/\bhttps?:\/\/[^\s)\]>"']+/gi, (url) => (allowed.has(url) ? url : "[link removed]"));
}
