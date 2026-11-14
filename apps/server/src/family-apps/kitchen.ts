/**
 * Send to kitchen: a recipe from a cookbook in Cook mode goes to Nighttime Ninja's recipe book.
 *
 * The web app reads the recipe's part of the EPUB (it already has the book open) and sends it as
 * blocks: headings, paragraphs and list items. Here they're sorted into a title, notes, ingredients
 * and steps, written as the plain-text format Nighttime Ninja's importer reads, parsed there
 * (`POST …/recipes/import` without saving), then saved with a link back to the cookbook page and
 * `noPublicShare`, because a recipe copied from a bought book shouldn't go on a public link.
 */
import { z } from "zod";

export const Block = z.object({
  type: z.enum(["heading", "text", "item"]),
  text: z.string().max(4000),
  /** For items: which kind of list they were in. */
  list: z.enum(["ol", "ul"]).optional(),
});
export type Block = z.infer<typeof Block>;

export const SendRecipeInput = z
  .object({
    bookId: z.string().min(1).max(64),
    /** The recipe's name from the table of contents. */
    title: z.string().trim().min(1).max(200),
    /** The table-of-contents href, so the link back opens at this recipe. */
    href: z.string().max(1000).optional(),
    blocks: z.array(Block).min(1).max(400),
  })
  .strict();

const ING_HEAD = /^(ingredients?|you(?:'|’)ll need|you will need|for the [\w ]+)\s*:?$/i;
const STEP_HEAD = /^(method|directions|instructions|preparation|steps|to make( it)?|how to make( it)?)\s*:?$/i;
const META = /^(serves|servings|yield|makes|prep(?:aration)?(?:\s*time)?|cook(?:ing)?(?:\s*time)?|total(?:\s*time)?)\b/i;
/** Starts with an amount: "2 cups", "½ tsp", "1/2 lb", "a pinch", "one onion", "pinch of salt". */
const AMOUNT = /^(\d|[¼½¾⅓⅔⅛⅜⅝⅞]|a\s+(pinch|handful|dash|few|couple|little|bunch|clove|splash)\b|(one|two|three|four|five|six|eight|ten|twelve|pinch|handful|dash)\b)/i;

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export interface SortedRecipe {
  title: string;
  head: string[];
  ingredients: string[];
  steps: string[];
}

/** Sorts a recipe's blocks into notes, ingredients and steps. */
export function sortBlocks(title: string, blocks: Block[]): SortedRecipe {
  const out: SortedRecipe = { title: clean(title), head: [], ingredients: [], steps: [] };
  let mode: "head" | "ing" | "steps" = "head";
  let explicit = false;
  for (const b of blocks) {
    const text = clean(b.text);
    if (!text) continue;
    if (b.type === "heading") {
      if (ING_HEAD.test(text)) {
        mode = "ing";
        explicit = true;
        if (/^for the /i.test(text)) out.ingredients.push(`${text.replace(/:$/, "")}:`);
      } else if (STEP_HEAD.test(text)) {
        mode = "steps";
        explicit = true;
      } else if (text.toLowerCase() !== out.title.toLowerCase() && mode === "head") {
        out.head.push(text);
      }
      continue;
    }
    if (mode === "head" && META.test(text) && text.length < 80) {
      out.head.push(text);
      continue;
    }
    if (explicit && mode !== "head") {
      (mode === "ing" ? out.ingredients : out.steps).push(text);
      continue;
    }
    // No headings to go by: guess from the shape of each block.
    if (b.type === "item") {
      if (b.list === "ol" || out.steps.length) out.steps.push(text);
      else out.ingredients.push(text);
      mode = out.steps.length ? "steps" : "ing";
    } else if (mode !== "steps" && AMOUNT.test(text) && text.length <= 90) {
      out.ingredients.push(text);
      mode = "ing";
    } else if (mode === "ing" || mode === "steps" || /^\d+[.)]\s/.test(text)) {
      out.steps.push(text);
      mode = "steps";
    } else {
      out.head.push(text);
    }
  }
  return out;
}

/** The plain-text recipe format Nighttime Ninja's importer reads. */
export function recipeText(r: SortedRecipe): string {
  const lines = [r.title, ...r.head];
  if (r.ingredients.length) lines.push("", "Ingredients", ...r.ingredients);
  if (r.steps.length) lines.push("", "Method", ...r.steps.map((s) => s.replace(/^\d+[.)]\s*/, "")));
  return lines.join("\n");
}

/** Nighttime Ninja's recipe shape, as far as we touch it. */
export interface NinjaRecipe {
  title: string;
  description?: string;
  sourceUrl: string | null;
  tags: string[];
  ingredients: unknown[];
  instructions: string[];
  [k: string]: unknown;
}
