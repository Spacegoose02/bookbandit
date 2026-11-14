import type { FoliateTocItem } from "foliate-js/view.js";

export interface Recipe {
  label: string;
  href: string;
  depth: number;
}

/** The book's contents as one flat, de-duplicated list for the Cook mode recipe index. */
export function flattenRecipes(items: FoliateTocItem[], depth = 0, seen = new Set<string>()): Recipe[] {
  const out: Recipe[] = [];
  for (const item of items) {
    const label = item.label?.replace(/\s+/g, " ").trim();
    if (label && item.href && !seen.has(item.href)) {
      seen.add(item.href);
      out.push({ label, href: item.href, depth });
    }
    if (item.subitems?.length) out.push(...flattenRecipes(item.subitems, depth + 1, seen));
  }
  return out;
}
