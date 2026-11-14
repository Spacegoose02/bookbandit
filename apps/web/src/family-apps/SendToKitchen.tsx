import { useEffect, useState } from "react";
import type { FoliateView } from "foliate-js/view.js";
import { familyAppsApi, type SentRecipe } from "./api";
import { recipeBlocks } from "./extract";
import "./family-apps.css";

/** Whether this grown-up can send recipes to Nighttime Ninja (it's linked and they aren't a kid). */
export function useKitchenLinked(): boolean {
  const [linked, setLinked] = useState(false);
  useEffect(() => {
    let live = true;
    familyAppsApi
      .linked()
      .then((l) => live && setLinked(l.kitchen))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return linked;
}

/**
 * Cook mode's "Send to kitchen" button for the recipe on screen: reads the recipe out of the open
 * book and adds it to Nighttime Ninja's recipe book, with a link back here.
 */
export function SendToKitchen({
  view,
  bookId,
  recipe,
  hrefs,
}: {
  view: FoliateView | null;
  bookId: string;
  recipe: { label: string; href: string } | null;
  hrefs: string[];
}) {
  const [state, setState] = useState<{ busy: boolean; sent?: SentRecipe; error?: string }>({ busy: false });
  useEffect(() => setState({ busy: false }), [recipe?.href]);
  if (!recipe) return null;

  const send = async () => {
    if (!view) return;
    setState({ busy: true });
    try {
      const blocks = await recipeBlocks(view, hrefs, recipe.href);
      if (!blocks.length) throw new Error("Barnaby couldn't read this page");
      const sent = await familyAppsApi.sendRecipe({ bookId, title: recipe.label, href: recipe.href, blocks });
      setState({ busy: false, sent });
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="bb-kitchen-send" aria-live="polite">
      <span className="bb-kitchen-recipe bb-small">
        On screen: <strong>{recipe.label}</strong>
      </span>
      {state.sent ? (
        <span className="bb-kitchen-ok bb-small">
          🦝 Added to Nighttime Ninja ({state.sent.ingredients} ingredients, {state.sent.steps} steps).{" "}
          <a href={state.sent.url} target="_blank" rel="noreferrer">
            Open it
          </a>
        </span>
      ) : (
        <button className="bb-btn" onClick={() => void send()} disabled={state.busy || !view} title={`Add "${recipe.label}" to Nighttime Ninja`}>
          {state.busy ? "Sending…" : "🍽 Send to kitchen"}
        </button>
      )}
      {state.error && <span className="bb-error bb-small">{state.error}</span>}
    </div>
  );
}
